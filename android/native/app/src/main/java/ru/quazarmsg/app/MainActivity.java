package ru.quazarmsg.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Свой модуль регистрируем до создания моста, иначе веб-часть его не увидит.
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        createNotificationChannels();
    }

    /**
     * Каналы уведомлений: каждый человек может настроить в «Настройках» Android отдельно.
     * Идентификаторы совпадают с backend/app/core/fcm.py. Канал создаётся один раз — звук и
     * важность потом меняет только сам человек.
     */
    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel messages = new NotificationChannel("messages", "Сообщения", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Личные чаты, группы и сообщения в Звёздах");

        NotificationChannel calls = new NotificationChannel("calls", "Звонки", NotificationManager.IMPORTANCE_HIGH);
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

        NotificationChannel rooms = new NotificationChannel("rooms", "Комнаты", NotificationManager.IMPORTANCE_HIGH);
        rooms.setDescription("Приглашения в комнаты и стук в дверь");

        NotificationChannel general = new NotificationChannel("general", "Прочее", NotificationManager.IMPORTANCE_DEFAULT);
        general.setDescription("Встречи из зелёного колокольчика и вход на новом устройстве");

        manager.createNotificationChannels(Arrays.asList(messages, calls, rooms, general));
    }
}
