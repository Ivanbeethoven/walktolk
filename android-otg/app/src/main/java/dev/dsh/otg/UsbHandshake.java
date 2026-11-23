package dev.dsh.otg;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

final class UsbHandshake {
    private static final int RETRY_MS = 1500;
    private static final int ATTEMPTS = 3;
    private final UsbManager manager;
    private final UsbDevice device;
    private final Consumer<String> log;
    private final BooleanSupplier cancelled;
    private final long sid = ThreadLocalRandom.current().nextLong(1, 0x100000000L);

    UsbHandshake(UsbManager manager, UsbDevice device, Consumer<String> log, BooleanSupplier cancelled) {
        this.manager = manager;
        this.device = device;
        this.log = log;
        this.cancelled = cancelled;
    }

    String run() throws IOException {
        for (int index = 0; index < device.getInterfaceCount(); index++) {
            UsbInterface iface = device.getInterface(index);
            log.accept("接口 " + iface.getId() + "，类别 " + iface.getInterfaceClass());
            if (iface.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
            UsbEndpoint in = null;
            UsbEndpoint out = null;
            for (int n = 0; n < iface.getEndpointCount(); n++) {
                UsbEndpoint ep = iface.getEndpoint(n);
                log.accept(String.format(Locale.ROOT, "端点 0x%02X  %s  type=%d  maxPacket=%d",
                        ep.getAddress(), ep.getDirection() == UsbConstants.USB_DIR_IN ? "IN" : "OUT",
                        ep.getType(), ep.getMaxPacketSize()));
                if (ep.getType() != UsbConstants.USB_ENDPOINT_XFER_INT) continue;
                if (ep.getDirection() == UsbConstants.USB_DIR_IN) in = ep;
                else out = ep;
            }
            if (in == null) continue;
            log.accept("主机 hello，v=1，sid=" + sid);
            if (out != null) {
                try {
                    return exchange(iface, in, out);
                } catch (IOException error) {
                    log.accept("中断 OUT 测试结束：" + error.getMessage());
                }
            }
            checkActive();
            return exchange(iface, in, null);
        }
        throw new IOException("未找到带中断 IN 端点的 HID 接口");
    }

    private void checkActive() {
        if (cancelled.getAsBoolean()) throw new CancellationException();
    }

    // One connection per write method keeps completions from a timed-out request separate.
    private String exchange(UsbInterface iface, UsbEndpoint in, UsbEndpoint out) throws IOException {
        checkActive();
        String method = out == null ? "HID SET_REPORT" : "中断 OUT";
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) throw new IOException("无法打开 USB 设备");
        boolean claimed = false;
        try {
            claimed = connection.claimInterface(iface, true);
            if (!claimed) throw new IOException("无法取得 HID 接口 " + iface.getId());
            log.accept("已取得 HID 接口，使用" + method + " 写入");
            UsbRequest reader = new UsbRequest();
            UsbRequest writer = new UsbRequest();
            try {
                if (!reader.initialize(connection, in)) throw new IOException("无法初始化中断 IN");
                if (out != null && !writer.initialize(connection, out)) {
                    throw new IOException("无法初始化中断 OUT");
                }
                try {
                    return receiveHello(connection, iface, reader, out == null ? null : writer, method);
                } finally {
                    reader.cancel();
                    if (out != null) writer.cancel();
                }
            } finally {
                reader.close();
                writer.close();
            }
        } finally {
            try {
                if (claimed) connection.releaseInterface(iface);
            } finally {
                connection.close();
            }
        }
    }

    private String receiveHello(UsbDeviceConnection connection, UsbInterface iface,
                                UsbRequest reader, UsbRequest writer, String method) throws IOException {
        byte[] hello = DeckFrames.hello(sid);
        ByteBuffer input = ByteBuffer.allocateDirect(DeckFrames.REPORT_SIZE);
        ByteBuffer output = ByteBuffer.allocateDirect(hello.length);
        byte[] bytes = new byte[DeckFrames.REPORT_SIZE];
        DeckFrames frames = new DeckFrames();
        if (!reader.queue(input)) throw new IOException("中断 IN 读取请求未提交");
        boolean writing = false;
        int reports = 0;
        for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
            checkActive();
            log.accept("发送 hello " + attempt + "/" + ATTEMPTS + "（" + method + "）");
            long deadline = SystemClock.elapsedRealtime() + RETRY_MS;
            if (writer == null) {
                // HID class request to this interface: SET_REPORT(Output, report ID 6).
                int count = connection.controlTransfer(0x21, 0x09, 0x0200 | DeckFrames.REPORT_ID,
                        iface.getId(), hello, hello.length, 800);
                if (count != hello.length) throw new IOException("SET_REPORT 写入结果：" + count + " 字节");
            } else {
                if (writing) throw new IOException("中断 OUT 写入超时");
                output.clear();
                output.put(hello).flip();
                if (!writer.queue(output)) throw new IOException("中断 OUT 写入请求未提交");
                writing = true;
            }
            long remaining;
            while ((remaining = deadline - SystemClock.elapsedRealtime()) > 0) {
                checkActive();
                UsbRequest done;
                try {
                    done = connection.requestWait(remaining);
                } catch (TimeoutException timeout) {
                    break;
                }
                if (done == null) throw new IOException("USB 请求失败，设备可能已断开");
                if (done == writer) {
                    writing = false;
                    if (output.position() != hello.length) {
                        throw new IOException("中断 OUT 写入结果：" + output.position() + " 字节");
                    }
                } else if (done == reader) {
                    input.flip();
                    int count = input.remaining();
                    input.get(bytes, 0, count);
                    if (count == 0) throw new IOException("中断 IN 返回空报文");
                    reports++;
                    if (reports <= 3 && count >= 3) {
                        log.accept(String.format(Locale.ROOT, "接收 %d 字节，report=%d，通道=%d，载荷=%d",
                                count, bytes[0] & 255, bytes[1] & 255, bytes[2] & 255));
                    }
                    for (String line : frames.accept(bytes, count)) {
                        log.accept("收到：" + line);
                        try {
                            JSONObject message = new JSONObject(line);
                            Object fw = message.opt("fw");
                            if ("hello".equals(message.opt("m")) && fw instanceof String && !((String) fw).isEmpty()) {
                                return (String) fw;
                            }
                        } catch (JSONException invalidLine) {
                            log.accept("此行无法解析为 JSON");
                        }
                    }
                    input.clear();
                    if (!reader.queue(input)) throw new IOException("无法继续读取中断 IN");
                }
            }
        }
        throw new IOException(method + " 已接收 " + reports + " 个报文，未收到完整的 deck hello");
    }
}
