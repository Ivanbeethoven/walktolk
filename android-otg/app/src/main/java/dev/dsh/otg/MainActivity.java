package dev.dsh.otg;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Typeface;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String PERMISSION = "dev.dsh.otg.USB_PERMISSION";
    private static final int VID = 0x1209;
    private static final int PID = 0x5754;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final DateTimeFormatter time = DateTimeFormatter.ofPattern("HH:mm:ss", Locale.ROOT);
    private UsbManager manager;
    private TextView status, output;
    private Button start, bridge;
    private boolean wantBridge, watchingBridge;
    private final Handler monitor = new Handler(Looper.getMainLooper());
    private final Runnable showBridge = new Runnable() {
        @Override public void run() {
            if (BridgeService.active) {
                watchingBridge = true;
                status.setText(BridgeService.status);
                bridge.setText(R.string.disconnect);
                start.setEnabled(false);
            } else if (watchingBridge) {
                watchingBridge = false;
                status.setText(BridgeService.status);
                bridge.setText(R.string.connect);
                start.setEnabled(true);
            }
            monitor.postDelayed(this, 500);
        }
    };
    private ScrollView scroll;
    private File logFile;
    private UsbDevice active;
    private volatile int generation;

    private final BroadcastReceiver events = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (active == null) return;
            if (PERMISSION.equals(intent.getAction())) {
                if (intent.getIntExtra("run", -1) != generation) return;
                if (!manager.getDeviceList().containsKey(active.getDeviceName())) {
                    finishRun("设备已断开");
                } else if (manager.hasPermission(active)) {
                    beginIo();
                } else {
                    finishRun("未取得 USB 授权，可点「开始测试」重试");
                }
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                UsbDevice detached = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (detached != null && active.getDeviceName().equals(detached.getDeviceName())) {
                    finishRun("设备已断开");
                }
            }
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        manager = getSystemService(UsbManager.class);
        File dir = getExternalFilesDir(null);
        logFile = new File(dir == null ? getFilesDir() : dir, "otg-hello.log");
        makeScreen();
        if (logFile.isFile()) {
            try {
                output.setText(new String(Files.readAllBytes(logFile.toPath()), StandardCharsets.UTF_8));
                status.setText(R.string.last_test);
            } catch (IOException ignored) {
                status.setText(R.string.waiting_device);
            }
        }
        IntentFilter actions = new IntentFilter(PERMISSION);
        actions.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        // The signature permission also protects the callback on Android 8–12.
        int flags = Build.VERSION.SDK_INT >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0;
        registerReceiver(events, actions, "dev.dsh.otg.INTERNAL_USB_EVENT", null, flags);
        if (!BridgeService.active && findDeck() != null) scan(DeckSocket.pairing(this).isFile());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction()) && active == null && !BridgeService.active) {
            scan(DeckSocket.pairing(this).isFile());
        }
    }

    private UsbDevice findDeck() {
        for (UsbDevice device : manager.getDeviceList().values()) {
            if (device.getVendorId() == VID && device.getProductId() == PID) return device;
        }
        return null;
    }

    private void scan(boolean connect) {
        if (active != null || BridgeService.active) return;
        wantBridge = connect;
        try {
            UsbDevice device = findDeck();
            logFile = new File(logFile.getParentFile(), connect ? "otg-connect.log" : "otg-hello.log");
            output.setText("");
            try {
                Files.write(logFile.toPath(), new byte[0]);
            } catch (IOException e) {
                output.append("无法创建日志文件：" + e.getMessage() + "\n");
            }
            if (device == null) {
                if (connect && DeckSocket.pairing(this).isFile()) {
                    checkDesktop();
                    return;
                }
                status.setText(R.string.no_device);
                line("等待设备 1209:5754。请使用支持数据传输的 USB-C 线连接手机和 deck，再点「开始测试」。");
                for (UsbDevice seen : manager.getDeviceList().values()) {
                    line(String.format(Locale.ROOT, "手机已枚举 USB 设备 %04X:%04X",
                            seen.getVendorId(), seen.getProductId()));
                }
                return;
            }
            active = device;
            int id = ++generation;
            start.setEnabled(false);
            line("已发现 deck 1209:5754，" + active.getDeviceName());
            if (manager.hasPermission(active)) {
                beginIo();
                return;
            }
            status.setText(R.string.waiting_permission);
            line("请在系统对话框中允许访问 USB 设备。");
            Intent callback = new Intent(PERMISSION).setPackage(getPackageName()).putExtra("run", id);
            PendingIntent result = PendingIntent.getBroadcast(this, id, callback,
                    PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE);
            manager.requestPermission(active, result);
        } catch (RuntimeException error) {
            finishRun("USB 设备检查失败：" + detail(error));
        }
    }

    private void checkDesktop() {
        start.setEnabled(false);
        bridge.setEnabled(false);
        status.setText(R.string.checking_dsh);
        line("手机未连接 deck，正在检查桌面 DSH 的网络回包。");
        final int id = ++generation;
        worker.execute(() -> {
            String result;
            try {
                DeckSocket socket = DeckSocket.paired(this);
                try {
                    if (!socket.connectBlocking(8, java.util.concurrent.TimeUnit.SECONDS)) {
                        throw new IOException("WebSocket 连接失败 " + socket.problem);
                    }
                    byte[] data = socket.toDeck.poll(7, java.util.concurrent.TimeUnit.SECONDS);
                    if (data == null || new DeckFrames().accept(data, data.length).stream()
                            .noneMatch(line -> line.contains("\"m\":\"hello\""))) {
                        throw new IOException("未收到 DSH 的 hello 请求");
                    }
                    result = "手机已收到桌面 DSH 的 hello 请求，可以连接 deck";
                } finally { socket.close(); }
            } catch (Exception error) { result = "桌面连接检查失败：" + detail(error); }
            String message = result;
            runOnUiThread(() -> {
                if (id != generation) return;
                bridge.setEnabled(true);
                finishRun(message);
            });
        });
    }

    private void beginIo() {
        final int id = generation;
        UsbDevice device = active;
        if (wantBridge) {
            if (!DeckSocket.pairing(this).isFile()) { finishRun("请先完成桌面配对"); return; }
            startForegroundService(new Intent(this, BridgeService.class).putExtra(BridgeService.DEVICE, device.getDeviceName()));
            finishRun("正在连接桌面 DSH");
            return;
        }
        status.setText(R.string.waiting_hello);
        line("USB 访问已获授权");
        worker.execute(() -> {
            UsbHandshake test = new UsbHandshake(manager, device,
                    message -> runOnUiThread(() -> { if (id == generation) line(message); }),
                    () -> id != generation || Thread.currentThread().isInterrupted());
            String result;
            try {
                String fw = test.run();
                result = "0.14.0".equals(fw) ? "握手成功 · 固件 0.14.0" : "收到 deck hello · 固件 " + fw;
            } catch (CancellationException ended) {
                return;
            } catch (IOException | RuntimeException error) {
                result = "握手未完成：" + detail(error);
            }
            String finalResult = result;
            runOnUiThread(() -> { if (id == generation) finishRun(finalResult); });
        });
    }

    private static String detail(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private void finishRun(String result) {
        generation++;
        active = null;
        status.setText(result);
        line(result);
        start.setEnabled(true);
    }

    private void line(String message) {
        String entry = LocalTime.now().format(time) + "  " + message + "\n";
        output.append(entry);
        try {
            Files.write(logFile.toPath(), entry.getBytes(StandardCharsets.UTF_8),
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException error) {
            output.append("日志文件写入失败：" + error.getMessage() + "\n");
        }
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private TextView label(String content, int size) {
        TextView view = new TextView(this);
        view.setText(content);
        view.setTextSize(size);
        return view;
    }

    private void makeScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(16));
        setContentView(root);
        TextView heading = label("Deck 连接", 23);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(heading);
        status = label("等待连接 deck", 18);
        status.setPadding(0, dp(12), 0, dp(6));
        root.addView(status);
        root.addView(label("蓝牙连接需要支持无线控制的 deck 固件。", 15));
        bridge = new Button(this);
        bridge.setText(R.string.connect);
        bridge.setOnClickListener(v -> {
            if (BridgeService.active) {
                stopService(new Intent(this, BridgeService.class));
                BridgeService.status = "已断开 DSH";
            } else {
                scan(true);
            }
        });
        root.addView(bridge);
        Button bluetooth = new Button(this);
        bluetooth.setText("通过蓝牙连接 deck");
        bluetooth.setOnClickListener(v -> connectBluetooth());
        root.addView(bluetooth);
        Button sessions = new Button(this);
        sessions.setText(R.string.sessions);
        sessions.setOnClickListener(v -> startActivity(new Intent(this, SessionsActivity.class)));
        root.addView(sessions);
        LinearLayout buttons = new LinearLayout(this);
        buttons.setPadding(0, dp(8), 0, dp(8));
        root.addView(buttons);
        start = new Button(this);
        start.setText("开始测试");
        start.setOnClickListener(v -> scan(false));
        buttons.addView(start);
        Button copy = new Button(this);
        copy.setText("复制日志");
        copy.setOnClickListener(v -> {
            getSystemService(ClipboardManager.class).setPrimaryClip(
                    ClipData.newPlainText("Deck OTG", output.getText().toString()));
            Toast.makeText(this, "已复制测试日志", Toast.LENGTH_SHORT).show();
        });
        buttons.addView(copy);
        scroll = new ScrollView(this);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        output = label("", 14);
        output.setTypeface(Typeface.MONOSPACE);
        output.setTextIsSelectable(true);
        scroll.addView(output);
    }

    private void connectBluetooth() {
        if (active != null || BridgeService.active) {
            status.setText("请先断开当前连接");
            return;
        }
        if (!DeckSocket.pairing(this).isFile()) { status.setText("请先完成桌面配对"); return; }
        String[] permissions = Build.VERSION.SDK_INT >= 31
                ? new String[]{android.Manifest.permission.BLUETOOTH_SCAN, android.Manifest.permission.BLUETOOTH_CONNECT}
                : new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION};
        for (String permission : permissions) {
            if (checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(permissions, 42);
                return;
            }
        }
        watchingBridge = true;
        BridgeService.status = "正在连接蓝牙 deck";
        startForegroundService(new Intent(this, BridgeService.class).putExtra(BridgeService.BLE, true));
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code != 42) return;
        for (int grant : grants) {
            if (grant != android.content.pm.PackageManager.PERMISSION_GRANTED) { status.setText("需要附近设备权限"); return; }
        }
        if (grants.length > 0) connectBluetooth();
    }

    @Override protected void onDestroy() {
        generation++;
        unregisterReceiver(events);
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override protected void onResume() {
        super.onResume();
        monitor.post(showBridge);
    }

    @Override protected void onPause() {
        monitor.removeCallbacks(showBridge);
        super.onPause();
    }
}
