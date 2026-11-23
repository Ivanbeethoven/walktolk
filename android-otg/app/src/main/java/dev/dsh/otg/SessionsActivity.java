package dev.dsh.otg;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.widget.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;

public final class SessionsActivity extends Activity {
    private WebView web;
    private Uri origin;

    private boolean trustedOrigin(Uri url) {
        return "https".equals(url.getScheme()) && origin.getHost().equalsIgnoreCase(url.getHost())
                && origin.getPort() == url.getPort() && url.getUserInfo() == null;
    }

    // The DSH web client runs JavaScript on its paired HTTPS origin.
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            JSONObject config = new JSONObject(new String(Files.readAllBytes(DeckSocket.pairing(this).toPath()), StandardCharsets.UTF_8));
            Uri socket = Uri.parse(config.getString("url"));
            origin = socket.buildUpon().scheme("https").path("").clearQuery().build();
            String access = "";
            CookieManager cookies = CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            for (String cookie : config.getString("cookie").split("; *")) {
                cookies.setCookie(origin.toString(), cookie + "; Path=/; Secure; HttpOnly");
                if (cookie.startsWith("dsh_relay=")) access = cookie.substring("dsh_relay=".length());
            }
            if (access.isEmpty()) throw new IllegalStateException();
            LinearLayout panel = new LinearLayout(this);
            panel.setOrientation(LinearLayout.VERTICAL);
            Button back = new Button(this);
            back.setText(R.string.back_to_deck);
            back.setOnClickListener(v -> finish());
            panel.addView(back);
            web = new WebView(this);
            panel.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
            setContentView(panel);
            web.getSettings().setAllowFileAccess(false);
            web.getSettings().setAllowContentAccess(false);
            web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            web.getSettings().setDomStorageEnabled(true);
            web.getSettings().setJavaScriptEnabled(true);
            web.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return !trustedOrigin(request.getUrl());
                }
            });
            web.loadUrl(origin.buildUpon().path("/ssh-bridge").appendQueryParameter("go", "1")
                    .appendQueryParameter("rk", access).build().toString());
        } catch (Exception error) {
            TextView message = new TextView(this);
            message.setText(R.string.pair_first);
            setContentView(message);
        }
    }

    @Override protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
