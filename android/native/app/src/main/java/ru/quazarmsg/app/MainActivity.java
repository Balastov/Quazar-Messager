package ru.quazarmsg.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Свой модуль регистрируем до создания моста, иначе веб-часть его не увидит.
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
