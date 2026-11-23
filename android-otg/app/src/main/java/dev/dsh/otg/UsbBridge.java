package dev.dsh.otg;

import android.content.Context;
import android.hardware.usb.*;
import android.os.SystemClock;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

final class UsbBridge {
    static void run(Context context, UsbDevice device, BooleanSupplier running, Consumer<String> status) throws Exception {
        UsbManager usb = context.getSystemService(UsbManager.class);
        UsbDeviceConnection connection = usb.openDevice(device);
        if (connection == null) throw new IOException("无法打开 deck");
        UsbInterface claimed = null;
        try {
            for (int i = 0; i < device.getInterfaceCount(); i++) {
                UsbInterface iface = device.getInterface(i);
                if (iface.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
                UsbEndpoint input = null, output = null;
                for (int n = 0; n < iface.getEndpointCount(); n++) {
                    UsbEndpoint ep = iface.getEndpoint(n);
                    if (ep.getType() != UsbConstants.USB_ENDPOINT_XFER_INT) continue;
                    if (ep.getDirection() == UsbConstants.USB_DIR_IN) input = ep;
                    else output = ep;
                }
                if (input == null) continue;
                if (!connection.claimInterface(iface, true)) throw new IOException("无法取得 HID 接口");
                claimed = iface;
                status.accept("USB 已授权，正在连接桌面 DSH");
                DeckSocket socket = DeckSocket.paired(context);
                try {
                    if (!socket.connectBlocking(8, TimeUnit.SECONDS)) throw new IOException("DSH 连接失败 " + socket.problem);
                    status.accept("DSH 已连接，等待 deck 回包");
                    transfer(connection, iface, input, output, socket, running, status);
                } finally {
                    socket.close();
                }
                return;
            }
            throw new IOException("未找到 deck 的中断 IN 端点");
        } finally {
            if (claimed != null) connection.releaseInterface(claimed);
            connection.close();
        }
    }

    private static void transfer(UsbDeviceConnection conn, UsbInterface iface, UsbEndpoint in, UsbEndpoint out,
                                 DeckSocket ws, BooleanSupplier running, Consumer<String> status) throws Exception {
        UsbRequest reader = new UsbRequest(), writer = new UsbRequest();
        ByteBuffer read = ByteBuffer.allocateDirect(64), write = ByteBuffer.allocateDirect(64);
        boolean readerReady = false, writerReady = false;
        try {
            readerReady = reader.initialize(conn, in);
            if (!readerReady || !reader.queue(read)) throw new IOException("无法开始 USB 读取");
            if (out != null) {
                writerReady = writer.initialize(conn, out);
                if (!writerReady) throw new IOException("无法打开 USB 写入端点");
            }
            boolean writing = false;
            long lastWrite = -1000, nextStatus = 0;
            int sent = 0, received = 0, voice = 0;
            while (running.getAsBoolean()) {
                if (!ws.isOpen()) throw new IOException("与桌面 DSH 的连接已断开 " + ws.problem);
                long now = SystemClock.elapsedRealtime();
                if (writing && now - lastWrite > 1500) throw new IOException("USB 写入超时");
                if (!writing && now - lastWrite >= 8) {
                    byte[] report = ws.toDeck.poll();
                    if (report != null) {
                        lastWrite = now;
                        if (out == null) {
                            if (conn.controlTransfer(0x21, 0x09, 0x0206, iface.getId(), report, 64, 700) != 64) {
                                throw new IOException("HID SET_REPORT 写入失败");
                            }
                            sent++;
                        } else {
                            write.clear(); write.put(report).flip();
                            if (!writer.queue(write)) throw new IOException("无法提交 USB 写入请求");
                            writing = true;
                        }
                    }
                }
                if (received > 0 && now >= nextStatus) {
                    status.accept("DSH 已连接 · 发往 deck " + sent + " 包，收到 " + received + " 包，语音 " + voice + " 包");
                    nextStatus = now + 2000;
                }
                UsbRequest done;
                try { done = conn.requestWait(ws.toDeck.isEmpty() ? 24 : 8); }
                catch (TimeoutException timeout) { continue; }
                if (done == null) throw new IOException("USB 连接已断开");
                if (done == writer) {
                    if (write.position() != 64) throw new IOException("USB 写入不完整");
                    writing = false;
                    sent++;
                } else if (done == reader) {
                    int count = read.position();
                    byte[] report = new byte[64];
                    read.flip();
                    read.get(report, 0, count);
                    read.clear();
                    if (count == 0 || !reader.queue(read)) throw new IOException("USB 读取中断");
                    if (!DeckSocket.valid(report, count)) continue;
                    received++;
                    if (report[1] == 7) voice++;
                    ws.send(report);
                }
            }
        } finally {
            if (readerReady) reader.cancel();
            if (writerReady) writer.cancel();
            reader.close(); writer.close();
        }
    }
}
