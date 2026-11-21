package ru.quazarmsg.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import java.util.Arrays;

/**
 * Каналы уведомлений: каждый человек настраивает в «Настройках» Android отдельно.
 * Идентификаторы совпадают с backend/app/core/fcm.py. Канал создаётся один раз — звук и важность
 * потом меняет только сам человек. Создаём и при запуске приложения, и при первом уведомлении
 * (звонок может прийти раньше, чем приложение открыли после обновления).
 */
final class NotificationChannels {
    static final String MESSAGES = "messages";
    static final String CALLS = "calls";
    static final String ROOMS = "rooms";
    static final String GENERAL = "general";

    private NotificationChannels() {}

    static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel messages = new NotificationChannel(MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Личные чаты, группы и сообщения в Звёздах");

        NotificationChannel calls = new NotificationChannel(CALLS, "Звонки", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Входящие звонки");
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] {0, 600, 400, 600});
        calls.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationChannel rooms = new NotificationChannel(ROOMS, "Комнаты", NotificationManager.IMPORTANCE_HIGH);
        rooms.setDescription("Приглашения в комнаты и стук в дверь");

        NotificationChannel general = new NotificationChannel(GENERAL, "Прочее", NotificationManager.IMPORTANCE_DEFAULT);
        general.setDescription("Встречи из зелёного колокольчика и вход на новом устройстве");

        manager.createNotificationChannels(Arrays.asList(messages, calls, rooms, general));
    }
}
