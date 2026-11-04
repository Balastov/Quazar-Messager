import { useContext, useEffect, useRef, useState } from "react";
import { version } from "../../package.json";
import { desktop, type DesktopBridge, type DesktopUpdate } from "../platform/desktop";
import { isNewerVersion } from "../platform/appVersion";
import { DesktopDownloadContext } from "./DesktopDownloadContext";
import WebDesktopDownload from "./WebDesktopDownload";
import s from "./AppVersion.module.css";

export default function AppVersion() {
  const bridge = desktop();
  const downloads = useContext(DesktopDownloadContext);
  return bridge ? <DesktopVersion bridge={bridge} /> : <>
    <Version value={version} />
    <WebDesktopDownload os={downloads?.os === "windows" || downloads?.os === "mac" ? downloads.os : undefined} currentVersion={version} />
  </>;
}

function Version({ value }: { value: string }) {
  return <span className={s.version} aria-label={`Версия приложения ${value}`}>{value}</span>;
}

function DesktopVersion({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<DesktopUpdate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const installing = useRef(false);
  useEffect(() => {
    let active = true, received = false;
    const off = bridge.onUpdate(value => { if (active) { received = true; setState(value); setError(""); } });
    void bridge.updateState().then(value => { if (active && !received) setState(value); }).catch(() => {});
    return () => { active = false; off(); };
  }, [bridge]);

  const available = !!state?.version && isNewerVersion(state.version, bridge.version) &&
    ["available", "downloading", "downloaded"].includes(state.status);
  const ready = state?.status === "downloaded" || (state?.manual && state.status === "available");
  const install = async () => {
    if (!ready || installing.current) return;
    installing.current = true; setBusy(true); setError("");
    try {
      const result = await bridge.installUpdate();
      if (!result.ok) setError(result.reason ?? "Не удалось установить обновление");
    } catch { setError("Не удалось начать обновление. Повторите попытку."); }
    finally { installing.current = false; setBusy(false); }
  };
  return <>
    <Version value={bridge.version} />
    {available && <>
      <button type="button" className={s.update} disabled={busy || !ready} onClick={() => void install()}
        title={state.manual ? `Скачать версию ${state.version} для Mac и установить вручную` : ready ? `Установить версию ${state.version} и перезапустить` : "Обновление загружается в фоне"}>Обновить</button>
      {state.status === "downloading" && <span className={s.message} role="status">Загрузка: {state.progress ?? 0}%</span>}
      {state.manual && <span className={s.message}>Установка вручную</span>}
      {error && <span className={`${s.message} ${s.error}`} role="alert">{error}</span>}
    </>}
  </>;
}
