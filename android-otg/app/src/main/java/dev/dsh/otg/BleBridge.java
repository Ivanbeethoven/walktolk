package dev.dsh.otg;

import android.annotation.SuppressLint;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;
import android.os.SystemClock;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

@SuppressLint("MissingPermission")
final class BleBridge extends BluetoothGattCallback {
    static final UUID CONTROL = UUID.fromString("f65fc100-b23e-4c52-94f2-bc437242d398");
    private static final UUID RX = UUID.fromString("f65fc101-b23e-4c52-94f2-bc437242d398");
    private static final UUID TX = UUID.fromString("f65fc102-b23e-4c52-94f2-bc437242d398");
    private static final UUID AUDIO = UUID.fromString("e9895507-bb72-45e5-a802-ab38fe1e4bc1");
    private static final UUID MIC = UUID.fromString("6e25df5b-b48a-4203-bb04-f3d4caeb1b7a");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private final ArrayBlockingQueue<String> completed = new ArrayBlockingQueue<>(8);
    private final AtomicInteger controls = new AtomicInteger(), audioFrames = new AtomicInteger();
    private volatile String failure;
    private volatile int mtu = 23;
    private volatile DeckSocket socket;
    private BluetoothGatt gatt;

    static void run(Context context, BooleanSupplier running, Consumer<String> status) throws Exception {
        BleBridge bridge = new BleBridge();
        try {
            bridge.connect(context, running, status);
        } finally {
            DeckSocket ws = bridge.socket;
            bridge.socket = null;
            if (ws != null) ws.close();
            if (bridge.gatt != null) {
                bridge.gatt.disconnect();
                bridge.gatt.close();
            }
        }
    }

    private static BluetoothDevice find(BluetoothAdapter adapter) throws Exception {
        for (BluetoothDevice device : adapter.getBondedDevices()) {
            if ("OpenWalkieTalkie".equals(device.getName())) return device;
        }
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) throw new IOException("请打开手机蓝牙");
        ArrayBlockingQueue<ScanResult> found = new ArrayBlockingQueue<>(1);
        AtomicInteger error = new AtomicInteger();
        ScanCallback scan = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult result) { found.offer(result); }
            @Override public void onScanFailed(int code) { error.set(code); }
        };
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(AUDIO))
                .setDeviceName("OpenWalkieTalkie").build();
        scanner.startScan(Collections.singletonList(filter), new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scan);
        try {
            ScanResult result = found.poll(15, TimeUnit.SECONDS);
            if (result != null) return result.getDevice();
            if (error.get() != 0) throw new IOException("蓝牙扫描失败 " + error.get());
            throw new IOException("未发现 OpenWalkieTalkie");
        } finally { scanner.stopScan(scan); }
    }

    private void connect(Context context, BooleanSupplier running, Consumer<String> status) throws Exception {
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) throw new IOException("请打开手机蓝牙");
        status.accept("正在查找蓝牙 deck");
        BluetoothDevice device = find(adapter);
        gatt = device.connectGatt(context, false, this, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) throw new IOException("无法创建 GATT 连接");
        waitFor("connect", true);
        waitFor("discover", gatt.discoverServices());
        BluetoothGattService deck = gatt.getService(CONTROL), audio = gatt.getService(AUDIO);
        if (deck == null || deck.getCharacteristic(RX) == null || deck.getCharacteristic(TX) == null)
            throw new UnsupportedOperationException("deck 固件缺少蓝牙控制服务");
        BluetoothGattCharacteristic mic = audio == null ? null : audio.getCharacteristic(MIC);
        if (mic == null) throw new UnsupportedOperationException("deck 固件缺少麦克风服务");
        if (device.getBondState() != BluetoothDevice.BOND_BONDED) {
            status.accept("请确认手机和 deck 的蓝牙配对");
            if (device.getBondState() == BluetoothDevice.BOND_NONE && !device.createBond())
                throw new IOException("无法发起蓝牙配对");
            long deadline = SystemClock.elapsedRealtime() + 60000;
            while (device.getBondState() != BluetoothDevice.BOND_BONDED) {
                check();
                if (SystemClock.elapsedRealtime() >= deadline) throw new IOException("蓝牙配对超时");
                Thread.sleep(250);
            }
        }
        if (mtu < 169 && gatt.requestMtu(247)) waitFor("mtu", true);
        gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        subscribe(deck.getCharacteristic(TX), true);
        DeckSocket ws = DeckSocket.paired(context, true);
        socket = ws;
        if (!ws.connectBlocking(10, TimeUnit.SECONDS)) throw new IOException("DSH 连接失败 " + ws.problem);
        status.accept("蓝牙已连接，等待 deck hello");
        boolean listening = false;
        long next = 0;
        while (running.getAsBoolean()) {
            check();
            if (!ws.isOpen()) throw new IOException("DSH 连接已关闭 " + ws.problem);
            byte[] report = ws.toDeck.poll(100, TimeUnit.MILLISECONDS);
            if (report != null && report[1] == 5) {
                int end = 3 + (report[2] & 255);
                int size = Math.min(61, Math.max(1, mtu - 3));
                for (int offset = 3; offset < end; offset += size) {
                    byte[] part = Arrays.copyOfRange(report, offset, Math.min(offset + size, end));
                    write(deck.getCharacteristic(RX), part);
                }
            } else if (report != null && report[1] == 7 && report[2] == 2 && report[3] == 0x11) {
                boolean on = report[4] != 0;
                if (on != listening) { subscribe(mic, on); listening = on; }
            }
            if (controls.get() > 0 && SystemClock.elapsedRealtime() >= next) {
                status.accept("DSH 已连接 · 蓝牙控制 " + controls.get() + " 包，语音 " + audioFrames.get() + " 包");
                next = SystemClock.elapsedRealtime() + 2000;
            }
        }
    }

    private void subscribe(BluetoothGattCharacteristic c, boolean on) throws Exception {
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d == null || !gatt.setCharacteristicNotification(c, on)) throw new IOException("无法设置蓝牙通知");
        byte[] v = on ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
        boolean submitted;
        if (Build.VERSION.SDK_INT >= 33) submitted = gatt.writeDescriptor(d, v) == BluetoothStatusCodes.SUCCESS;
        else { d.setValue(v); submitted = gatt.writeDescriptor(d); }
        waitFor("notify", submitted);
    }

    private void write(BluetoothGattCharacteristic c, byte[] part) throws Exception {
        boolean submitted;
        if (Build.VERSION.SDK_INT >= 33)
            submitted = gatt.writeCharacteristic(c, part, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
        else {
            c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            c.setValue(part);
            submitted = gatt.writeCharacteristic(c);
        }
        waitFor("write", submitted);
    }

    private void check() throws IOException { if (failure != null) throw new IOException(failure); }
    private void waitFor(String operation, boolean started) throws Exception {
        check();
        if (!started) throw new IOException("无法发起 GATT " + operation);
        long deadline = SystemClock.elapsedRealtime() + 15000;
        while (true) {
            long remaining = Math.max(0, deadline - SystemClock.elapsedRealtime());
            String result = completed.poll(remaining, TimeUnit.MILLISECONDS);
            check();
            if (operation.equals(result)) return;
            // Android can report an existing system connection's MTU during discovery.
            if (result == null) throw new IOException("GATT " + operation + " 超时");
        }
    }
    private void finish(String op, int status) {
        if (status != BluetoothGatt.GATT_SUCCESS) failure = "GATT " + op + " 状态 " + status;
        completed.offer(op);
    }
    @Override public void onConnectionStateChange(BluetoothGatt g, int s, int state) {
        if (state == BluetoothProfile.STATE_DISCONNECTED) { failure = "deck 蓝牙已断开 " + s; completed.offer("disconnect"); }
        else if (state == BluetoothProfile.STATE_CONNECTED) finish("connect", s);
    }
    @Override public void onServicesDiscovered(BluetoothGatt g, int s) { finish("discover", s); }
    @Override public void onMtuChanged(BluetoothGatt g, int size, int s) {
        if (s == BluetoothGatt.GATT_SUCCESS) mtu = size;
        completed.offer("mtu");
    }
    @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int s) { finish("notify", s); }
    @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int s) { finish("write", s); }
    @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
        DeckSocket ws = socket;
        if (ws == null || !ws.isOpen() || value.length == 0) return;
        boolean mic = MIC.equals(c.getUuid());
        if ((!mic && !TX.equals(c.getUuid())) || value.length > (mic ? 166 : 61)) return;
        byte[] report = new byte[mic ? value.length + 3 : 64];
        report[0] = 6; report[1] = (byte) (mic ? 7 : 5); report[2] = (byte) value.length;
        System.arraycopy(value, 0, report, 3, value.length);
        try { ws.send(report); (mic ? audioFrames : controls).incrementAndGet(); }
        catch (RuntimeException e) { failure = "DSH 连接中断"; completed.offer("disconnect"); }
    }
    @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
        byte[] v = c.getValue();
        if (v != null) onCharacteristicChanged(g, c, v);
    }
}
