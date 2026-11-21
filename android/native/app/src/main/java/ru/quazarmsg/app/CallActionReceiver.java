package ru.quazarmsg.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * «Отклонить» на уведомлении или экране звонка: сразу гасим звонок на телефоне и говорим серверу —
 * без входа и без открытия Quazar, по ключу этого звонка из уведомления (POST /api/calls/{id}/decline).
 */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_DECLINE = "ru.quazarmsg.app.DECLINE_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DECLINE.equals(intent.getAction())) return;
        Bundle extras = intent.getExtras();
        if (extras == null) return;
        String callId = extras.getString("callId");
        String token = extras.getString("declineToken");
        IncomingCall.cancel(context, callId);
        if (callId == null || token == null) return;
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                decline(app, callId, token);
            } finally {
                pending.finish();
            }
        }).start();
    }

    private static void decline(Context context, String callId, String token) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(serverUrl(context) + "/api/calls/" + URLEncoder.encode(callId, "UTF-8") + "/decline");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] body = new JSONObject().put("token", token).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            connection.getResponseCode();
        } catch (Exception e) {
            // Нет связи — звонящий услышит «не отвечает», когда звонок кончится сам.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Адрес сервера — тот же, что открывает приложение (capacitor.config.json, server.url). */
    static String serverUrl(Context context) {
        try (InputStream in = context.getAssets().open("capacitor.config.json")) {
            byte[] bytes = new byte[in.available()];
            int read = in.read(bytes);
            String url = new JSONObject(new String(bytes, 0, Math.max(read, 0), StandardCharsets.UTF_8))
                .getJSONObject("server").getString("url");
            return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
        } catch (Exception e) {
            return "https://quazar-msg.ru";
        }
    }
}
