package ru.quazarmsg.app;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Сообщения Firebase. Звонки и «звонок окончен» приходят служебными сообщениями (без готового
 * уведомления) — их показывает само приложение, даже закрытое. Всё остальное — как раньше, плагину
 * Capacitor (обычные уведомления Android показывает сам).
 */
public class QuazarMessagingService extends MessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String kind = data.get("kind");
        if (message.getNotification() == null && "call_cancel".equals(kind)) {
            IncomingCall.cancel(this, data.get("callId"));
            return;
        }
        if (message.getNotification() == null && "call".equals(kind)) {
            // Quazar открыт и на экране — звонок покажет он сам (по WebSocket), второй звонок не нужен.
            if (!MainActivity.isVisible()) IncomingCall.show(this, IncomingCall.extras(data));
            return;
        }
        super.onMessageReceived(message);
    }
}
