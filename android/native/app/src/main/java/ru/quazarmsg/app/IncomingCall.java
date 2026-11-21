package ru.quazarmsg.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

import java.util.Map;

/**
 * Входящий звонок, когда Quazar закрыт или свёрнут: системное уведомление в стиле звонка
 * (CallStyle) с «Принять» / «Отклонить», рингтоном до ответа (FLAG_INSISTENT) и полноэкранным
 * экраном поверх блокировки (IncomingCallActivity). Гаснет само к концу звонка (endsAt) или по
 * сообщению «звонок окончен» от сервера.
 */
final class IncomingCall {
    static final String ACTION_ENDED = "ru.quazarmsg.app.CALL_ENDED";
    /** Данные звонка из сообщения Firebase (см. backend/app/core/fcm.py). */
    static final String[] KEYS = {"kind", "callId", "chatId", "callerId", "callerName", "video", "endsAt", "declineToken"};

    private IncomingCall() {}

    static String tag(String callId) {
        return "quazar-call-" + callId;
    }

    static int id(String callId) {
        return ("call:" + callId).hashCode();
    }

    static Bundle extras(Map<String, String> data) {
        Bundle bundle = new Bundle();
        for (String key : KEYS) {
            String value = data.get(key);
            if (value != null) bundle.putString(key, value);
        }
        return bundle;
    }

    static long endsAt(Bundle extras) {
        try {
            return Long.parseLong(extras.getString("endsAt", ""));
        } catch (NumberFormatException e) {
            return System.currentTimeMillis() + 45_000;
        }
    }

    static void show(Context context, Bundle extras) {
        String callId = extras.getString("callId");
        if (callId == null) return;
        long left = endsAt(extras) - System.currentTimeMillis();
        // Сообщение пролежало в пути дольше звонка — звонить уже некому.
        if (left <= 0) return;
        NotificationChannels.ensure(context);
        boolean video = "1".equals(extras.getString("video"));
        String name = extras.getString("callerName", "Собеседник");
        int id = id(callId);

        Intent screen = new Intent(context, IncomingCallActivity.class)
            .putExtras(extras)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent full = PendingIntent.getActivity(context, id, screen,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent answer = PendingIntent.getActivity(context, id + 1,
            new Intent(screen).setAction(IncomingCallActivity.ACTION_ANSWER),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent decline = PendingIntent.getBroadcast(context, id + 2,
            new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_DECLINE).putExtras(extras),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Person caller = new Person.Builder().setName(name).setImportant(true).build();
        Notification notification = new NotificationCompat.Builder(context, NotificationChannels.CALLS)
            .setSmallIcon(R.drawable.ic_stat_quazar)
            .setColor(ContextCompat.getColor(context, R.color.quazar_accent))
            .setContentTitle(video ? "Входящий видеозвонок" : "Входящий звонок")
            .setContentText(name)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setTimeoutAfter(left)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
            .build();
        // Рингтон канала «Звонки» — по кругу, пока звонок не примут, не отклонят или он не кончится.
        notification.flags |= Notification.FLAG_INSISTENT;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        try {
            if (manager != null) manager.notify(tag(callId), id, notification);
        } catch (SecurityException e) {
            // Уведомления запрещены в Android — звонок увидят, только открыв Quazar.
        }
    }

    /** Звонок больше не звонит: убрать уведомление и закрыть экран звонка. */
    static void cancel(Context context, String callId) {
        if (callId == null) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(tag(callId), id(callId));
        context.sendBroadcast(new Intent(ACTION_ENDED).setPackage(context.getPackageName()).putExtra("callId", callId));
    }
}
