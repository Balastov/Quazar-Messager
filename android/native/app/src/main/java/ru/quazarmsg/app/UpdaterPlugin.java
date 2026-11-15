package ru.quazarmsg.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

/**
 * Обновление приложения без магазина: скачать APK с quazar-msg.ru, проверить его и открыть
 * системное окно «Обновить приложение?».
 *
 * Проверяем всё, что можно, до установки: адрес только наш, SHA-256 совпадает с тем, что
 * объявил сервер, в файле — это же приложение, подписанное тем же ключом, и версия новее.
 * Android всё равно не поставит обновление с другой подписью, но так человек не увидит
 * непонятную ошибку установщика.
 */
@CapacitorPlugin(name = "QuazarUpdater")
public class UpdaterPlugin extends Plugin {
    private volatile boolean downloading = false;

    /** Обновления — только с того сервера, который открыт в приложении (в рабочей сборке — quazar-msg.ru). */
    private String allowedPrefix() {
        String server = getBridge().getServerUrl();
        if (server == null || server.isEmpty()) server = "https://quazar-msg.ru";
        return server.replaceAll("/+$", "") + "/desktop-updates/android/";
    }

    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageInfo me = currentPackage(0);
            JSObject out = new JSObject();
            out.put("versionName", me.versionName);
            out.put("versionCode", versionCode(me));
            out.put("canInstall", canInstall());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Не удалось узнать версию приложения", e);
        }
    }

    /** Открыть настройки «Установка неизвестных приложений» для Quazar. */
    @PluginMethod
    public void allowInstalls(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        Integer expectedCode = call.getInt("versionCode");
        if (!url.startsWith(allowedPrefix()) || url.contains("..")) {
            call.reject("Обновление можно скачать только с сервера Quazar", "bad_url");
            return;
        }
        if (!sha256.matches("[0-9a-f]{64}")) {
            call.reject("Сервер не прислал контрольную сумму обновления", "bad_hash");
            return;
        }
        if (!canInstall()) {
            call.reject("Разрешите Quazar устанавливать обновления", "not_allowed");
            return;
        }
        if (downloading) {
            call.reject("Обновление уже скачивается", "busy");
            return;
        }
        downloading = true;
        new Thread(() -> {
            try {
                File apk = download(url);
                String actual = hash(apk);
                if (!actual.equals(sha256)) throw new UpdateError("bad_hash", "Файл обновления повреждён — попробуйте ещё раз");
                checkPackage(apk, expectedCode);
                openInstaller(apk);
                call.resolve();
            } catch (UpdateError e) {
                call.reject(e.getMessage(), e.code);
            } catch (Exception e) {
                call.reject("Не удалось скачать обновление — проверьте интернет", "download", e);
            } finally {
                downloading = false;
            }
        }, "quazar-update").start();
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private File download(String address) throws Exception {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) throw new UpdateError("download", "Нет места для обновления");
        for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
        File target = new File(dir, "quazar-update.apk");
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        try {
            if (connection.getResponseCode() != 200) throw new UpdateError("download", "Обновление пока недоступно на сервере");
            long total = connection.getContentLengthLong();
            long done = 0;
            int lastPercent = -1;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    done += read;
                    if (total > 0) {
                        int percent = (int) (done * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject progress = new JSObject();
                            progress.put("percent", percent);
                            notifyListeners("progress", progress);
                        }
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
        return target;
    }

    private static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        try (InputStream in = new java.io.FileInputStream(file)) {
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest()) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }

    @SuppressWarnings("deprecation")
    private void checkPackage(File apk, Integer expectedCode) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo update = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (update == null || !getContext().getPackageName().equals(update.packageName)) {
            throw new UpdateError("bad_package", "Скачан не тот файл — обновление отменено");
        }
        PackageInfo me = currentPackage(flags);
        if (versionCode(update) <= versionCode(me) || (expectedCode != null && versionCode(update) != expectedCode)) {
            throw new UpdateError("bad_version", "На сервере нет более новой версии");
        }
        if (!Arrays.equals(signatures(update), signatures(me))) {
            throw new UpdateError("bad_signature", "Обновление подписано другим ключом — установка отменена");
        }
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signatures(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            return info.signingInfo.hasMultipleSigners()
                    ? info.signingInfo.getApkContentsSigners()
                    : info.signingInfo.getSigningCertificateHistory();
        }
        return info.signatures == null ? new Signature[0] : info.signatures;
    }

    private void openInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private PackageInfo currentPackage(int flags) throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static final class UpdateError extends Exception {
        final String code;

        UpdateError(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
