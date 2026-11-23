package dev.dsh.otg;

import android.app.*;
import android.content.*;
import android.hardware.usb.*;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.time.LocalTime;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class BridgeService extends Service {
    static volatile boolean active;
    static volatile String status = "";
    static final String DEVICE = "device";
    static final String BLE = "ble";
    private volatile boolean running;
    private long nextSample;
    private File log;
    private PowerManager.WakeLock bluetoothWake;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (running || intent == null) return START_NOT_STICKY;
        boolean ble = intent.getBooleanExtra(BLE, false);
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("deck", "Deck 连接", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification ongoing = new Notification.Builder(this, "deck").setSmallIcon(R.drawable.ic_usb)
                .setContentTitle(ble ? "Deck 蓝牙连接" : "Deck USB 连接").setContentText("正在转发桌面 DSH 的报文")
                .setContentIntent(open).setOngoing(true).build();
        startForeground(1, ongoing);
        if (ble) {
            bluetoothWake = getSystemService(PowerManager.class)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dev.dsh.otg:bluetooth");
            bluetoothWake.acquire();
        }
        active = running = true;
        log = new File(getExternalFilesDir(null), "otg-bridge.log");
        try { Files.write(log.toPath(), new byte[0]); } catch (IOException ignored) {}
        update("正在打开 deck");
        String name = intent.getStringExtra(DEVICE);
        worker.execute(() -> {
            UsbManager usb = getSystemService(UsbManager.class);
            try {
                while (running) {
                    try {
                        if (ble) {
                            BleBridge.run(this, () -> running, this::update);
                        } else {
                            UsbDevice device = usb.getDeviceList().get(name);
                            if (device == null || !usb.hasPermission(device)) { update("deck 已断开"); break; }
                            UsbBridge.run(this, device, () -> running, this::update);
                        }
                    } catch (InterruptedException stop) {
                        break;
                    } catch (UnsupportedOperationException error) {
                        update(error.getMessage());
                        break;
                    } catch (Exception error) {
                        if (!running) break;
                        update("正在重连 · " + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
                        Thread.sleep(2000);
                    }
                }
            } catch (InterruptedException stop) {
                Thread.currentThread().interrupt();
            } finally {
                stopSelf(startId);
            }
        });
        return START_NOT_STICKY;
    }

    private void update(String text) {
        status = text;
        if (text.startsWith("DSH 已连接 ·")) {
            long now = SystemClock.elapsedRealtime();
            if (now < nextSample) return;
            nextSample = now + 30000;
        }
        try {
            Files.write(log.toPath(), (LocalTime.now() + "  " + text + "\n").getBytes(StandardCharsets.UTF_8),
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {}
    }

    @Override public void onDestroy() {
        active = running = false;
        worker.shutdownNow();
        if (bluetoothWake != null && bluetoothWake.isHeld()) bluetoothWake.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
