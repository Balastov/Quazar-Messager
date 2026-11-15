import { useCallback, useEffect, useState } from "react";
import { ANDROID_UPDATE_POLL_INTERVAL, androidShell, latestAndroidRelease, type AndroidAppInfo,
  type AndroidRelease, type AndroidUpdater, type ListenerHandle } from "../platform/android";
import s from "./DesktopUpdates.module.css";

/** В приложении для Android: есть новая версия — предлагаем обновиться (системное окно «Обновить?»). */
export default function AndroidUpdates() {
  const shell = androidShell();
  return shell ? <AndroidUpdateBanner shell={shell} /> : null;
}

function AndroidUpdateBanner({ shell }: { shell: AndroidUpdater }) {
  const [app, setApp] = useState<AndroidAppInfo | null>(null);
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const [info, latest] = await Promise.all([shell.info(), latestAndroidRelease()]);
      setApp(info);
      setRelease(latest);
    } catch { /* Нет связи — проверим в следующий раз. */ }
  }, [shell]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), ANDROID_UPDATE_POLL_INTERVAL);
    // Вернулись из настроек «Установка неизвестных приложений» — узнаём, разрешили ли.
    const refresh = () => void check();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [check]);

  useEffect(() => {
    let off: ListenerHandle | undefined;
    let active = true;
    // Сбой подписки на прогресс не должен ронять приложение — просто не будет процентов.
    try {
      void Promise.resolve(shell.addListener("progress", ({ percent }) => setProgress(percent))).then((handle) => {
        if (active) off = handle; else void handle?.remove();
      }).catch(() => {});
    } catch { /* без процентов */ }
    return () => { active = false; try { void off?.remove(); } catch { /* уже отписались */ } };
  }, [shell]);

  if (!app || !release || release.versionCode <= app.versionCode || dismissed === release.version) return null;

  const install = async () => {
    setError(""); setProgress(0);
    try {
      await shell.install({ url: release.url, sha256: release.sha256, versionCode: release.versionCode });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Не удалось скачать обновление — проверьте интернет");
    } finally {
      setProgress(null);
    }
  };

  return <aside className={s.banner} aria-label="Обновление Quazar">
    <div role="status">
      <strong>{progress !== null ? `Загружаем обновление: ${progress}%` : `Доступна версия ${release.version} для Android`}</strong>
      <p>{app.canInstall
        ? "Скачаем обновление, а Android спросит, установить ли его. Ваши чаты и вход сохранятся."
        : "Чтобы обновляться без магазина, один раз разрешите Quazar устанавливать приложения: откроются настройки, включите переключатель и вернитесь сюда."}</p>
    </div>
    <div className={s.actions}>
      {app.canInstall
        ? <button type="button" disabled={progress !== null} onClick={() => void install()}>Обновить</button>
        : <button type="button" onClick={() => void shell.allowInstalls()}>Разрешить установку</button>}
      <button type="button" onClick={() => setDismissed(release.version)}>Позже</button>
    </div>
    {error && <p className={s.error} role="alert">{error}</p>}
  </aside>;
}
