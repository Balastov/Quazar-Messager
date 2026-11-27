package ru.quazarmsg.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * «Поделиться» → Quazar: текст, ссылки, фото и файлы из других приложений.
 *
 * Файлы копируем к себе (cache/shared/), пока у нас есть разрешение их читать, — веб-часть
 * забирает их по адресу /_capacitor_file_/… того же сайта и сама решает, куда отправить.
 * Нативная часть только готовит присланное: в какой чат — выбирает человек.
 *
 * Порядок: пришло присланное → копируем в фоне → событие «share» → веб-часть зовёт take(),
 * читает файлы и зовёт release() (тогда копии удаляются). Пока не забрали, присланное ждёт:
 * человек может сначала войти в аккаунт.
 */
@CapacitorPlugin(name = "QuazarShare")
public class SharePlugin extends Plugin {
    /** Как и для вложений на сервере: больше файл всё равно не уйдёт. */
    static final long MAX_FILE_BYTES = 50L * 1024 * 1024;
    static final int MAX_FILES = 20;
    static final int MAX_TEXT = 20_000;

    /** Готовое присланное; null — ничего нет или ещё копируем. */
    private JSObject ready;
    /** Номер присланного: старое копирование не перезапишет новое. */
    private volatile int generation;
    /** Чьи копии сейчас лежат в ready. */
    private int readyGeneration;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        // Открыли из «Недавних» после перезапуска — это старое присланное, его уже разобрали.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        // Пересоздание экрана не должно присылать то же самое ещё раз.
        if (getActivity() != null && getActivity().getIntent() == intent) getActivity().setIntent(new Intent(Intent.ACTION_MAIN));

        final int mine;
        synchronized (this) {
            mine = ++generation;
            ready = null;
        }
        final String text = sharedText(intent);
        final List<Uri> uris = sharedUris(intent);
        new Thread(() -> {
            JSObject share = collect(mine, text, uris);
            synchronized (this) {
                if (mine != generation) {
                    clearDir(mine);
                    return;
                }
                ready = share;
                readyGeneration = mine;
            }
            notifyListeners("share", new JSObject(), true);
        }, "quazar-share").start();
    }

    /** Присланное, если оно готово: {text, files: [{path, name, type, size}], skipped: [name]}. */
    @PluginMethod
    public void take(PluginCall call) {
        JSObject share;
        synchronized (this) {
            share = ready;
        }
        call.resolve(share == null ? new JSObject() : share);
    }

    /** Веб-часть прочитала файлы (или человек передумал) — копии больше не нужны. */
    @PluginMethod
    public void release(PluginCall call) {
        int gone;
        synchronized (this) {
            if (ready == null) {
                call.resolve();
                return;
            }
            ready = null;
            gone = readyGeneration;
        }
        clearDir(gone);
        call.resolve();
    }

    private static String sharedText(Intent intent) {
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null || text.toString().trim().isEmpty()) text = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        if (text == null) return "";
        String out = text.toString().trim();
        return out.length() > MAX_TEXT ? out.substring(0, MAX_TEXT) : out;
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> sharedUris(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Uri uri : list) if (uri != null) out.add(uri);
        } else {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) out.add(uri);
        }
        // Некоторые приложения кладут файлы только в ClipData.
        ClipData clip = intent.getClipData();
        if (out.isEmpty() && clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) out.add(uri);
            }
        }
        return out;
    }

    private File dir() {
        return new File(getContext().getCacheDir(), "shared");
    }

    /** Удалить копии одного присланного; 0 — все, кроме тех, что копирует присланное новее. */
    private void clearDir(int only) {
        File[] old = dir().listFiles();
        if (old == null) return;
        for (File f : old) {
            String owner = f.getName().split("-", 2)[0];
            boolean newer = owner.equals(String.valueOf(generation));
            if (only == 0 ? !newer : owner.equals(String.valueOf(only))) f.delete();
        }
    }

    private JSObject collect(int mine, String text, List<Uri> uris) {
        JSArray files = new JSArray();
        JSArray skipped = new JSArray();
        File dir = dir();
        // Старое присланное так и не забрали — его копии больше не нужны.
        clearDir(0);
        if (!uris.isEmpty() && !dir.exists()) dir.mkdirs();
        int n = 0;
        for (Uri uri : uris) {
            if (mine != generation) break;
            String name = displayName(uri);
            if (n >= MAX_FILES) {
                skipped.put(name);
                continue;
            }
            if (!readable(uri)) {
                skipped.put(name);
                continue;
            }
            File target = new File(dir, mine + "-" + n);
            long size = copy(uri, target);
            if (size < 0) {
                target.delete();
                skipped.put(name);
                continue;
            }
            JSObject file = new JSObject();
            file.put("path", target.getAbsolutePath());
            file.put("name", name);
            String type = getContext().getContentResolver().getType(uri);
            file.put("type", type == null ? "" : type);
            file.put("size", size);
            files.put(file);
            n++;
        }
        JSObject share = new JSObject();
        share.put("text", text);
        share.put("files", files);
        share.put("skipped", skipped);
        return share;
    }

    /**
     * Чужие файлы — только через content://. file:// и наши собственные провайдеры не берём:
     * иначе другое приложение могло бы «поделиться» нашими внутренними файлами и подсунуть их в чат.
     */
    private boolean readable(Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) return false;
        String authority = uri.getAuthority();
        if (authority == null) return false;
        try {
            ProviderInfo provider = getContext().getPackageManager().resolveContentProvider(authority, 0);
            return provider != null && !getContext().getPackageName().equals(provider.packageName);
        } catch (Exception e) {
            return false;
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (Exception ignored) {
                // Имя не отдали — придумаем.
            }
        }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        if (name == null) name = "";
        name = name.replaceAll("[/\\\\\\x00-\\x1f]", "_").trim();
        if (name.length() > 120) name = name.substring(name.length() - 120);
        return name.isEmpty() ? "файл" : name;
    }

    /** Копирует файл; -1 — не прочитался или больше 50 МБ. */
    private long copy(Uri uri, File target) {
        long done = 0;
        byte[] buffer = new byte[64 * 1024];
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             FileOutputStream out = new FileOutputStream(target)) {
            if (in == null) return -1;
            int read;
            while ((read = in.read(buffer)) != -1) {
                done += read;
                if (done > MAX_FILE_BYTES) return -1;
                out.write(buffer, 0, read);
            }
            return done;
        } catch (Exception | OutOfMemoryError e) {
            return -1;
        }
    }
}
