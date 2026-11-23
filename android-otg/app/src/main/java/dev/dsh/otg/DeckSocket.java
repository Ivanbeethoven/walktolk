package dev.dsh.otg;

import android.content.Context;
import android.util.Base64;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.io.File;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

final class DeckSocket extends WebSocketClient {
    final ArrayBlockingQueue<byte[]> toDeck = new ArrayBlockingQueue<>(128);
    volatile String problem = "";

    static File pairing(Context context) {
        return new File(context.getNoBackupFilesDir(), "deck-pairing.json");
    }

    // The locally paired relay presents a self-signed leaf. Only its exact DER is trusted.
    @android.annotation.SuppressLint("CustomX509TrustManager")
    static DeckSocket paired(Context context) throws Exception {
        return paired(context, false);
    }

    @android.annotation.SuppressLint("CustomX509TrustManager")
    static DeckSocket paired(Context context, boolean ble) throws Exception {
        JSONObject config = new JSONObject(new String(Files.readAllBytes(pairing(context).toPath()), StandardCharsets.UTF_8));
        URI uri = URI.create(config.getString("url"));
        if (!"wss".equals(uri.getScheme()) || !"/deck/usb".equals(uri.getPath())) {
            throw new IllegalArgumentException("无效的桌面配对地址");
        }
        Map<String,String> headers = new HashMap<>();
        if (ble) headers.put("X-Deck-Transport", "ble");
        headers.put("Cookie", config.getString("cookie"));
        headers.put("Authorization", "Bearer " + config.getString("key"));
        byte[] expected = Base64.decode(config.getString("cert"), Base64.DEFAULT);
        X509TrustManager pin = new X509TrustManager() {
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain == null || chain.length == 0 || !Arrays.equals(expected, chain[0].getEncoded())) {
                    throw new CertificateException("中继证书与配对记录不符");
                }
                chain[0].checkValidity();
            }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                throw new CertificateException("client certificates unsupported");
            }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[]{pin}, null);
        DeckSocket socket = new DeckSocket(uri, headers);
        socket.setSocketFactory(tls.getSocketFactory());
        socket.setTcpNoDelay(true);
        socket.setConnectionLostTimeout(15);
        return socket;
    }

    private DeckSocket(URI uri, Map<String,String> headers) {
        super(uri, new org.java_websocket.drafts.Draft_6455(), headers, 6000);
    }

    @Override protected void onSetSSLParameters(SSLParameters parameters) {
        // Pairing identifies the relay by its full certificate, including for IP URLs.
        parameters.setEndpointIdentificationAlgorithm(null);
    }
    @Override public void onOpen(ServerHandshake handshake) {}
    @Override public void onError(Exception error) { problem = error.getClass().getSimpleName(); }
    @Override public void onClose(int code, String reason, boolean remote) {
        if (problem.isEmpty()) problem = "WebSocket " + code;
    }
    @Override public void onMessage(String text) { close(1003, "binary HID required"); }
    @Override public void onMessage(ByteBuffer data) {
        if (data.remaining() != DeckFrames.REPORT_SIZE) { close(1002, "invalid report size"); return; }
        byte[] report = new byte[DeckFrames.REPORT_SIZE];
        data.get(report);
        if (!valid(report, report.length) || !toDeck.offer(report)) close(1002, "invalid or delayed report");
    }
    static boolean valid(byte[] report, int size) {
        return size >= 3 && report[0] == 6 && (report[1] == 5 || report[1] == 7)
                && (report[2] & 255) <= size - 3;
    }
}
