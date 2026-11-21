package ru.quazarmsg.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Quazar на экране: входящий звонок покажет сам (по WebSocket), без второго — системного. */
    private static volatile boolean visible;

    static boolean isVisible() {
        return visible;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Свой модуль регистрируем до создания моста, иначе веб-часть его не увидит.
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        NotificationChannels.ensure(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }
}
