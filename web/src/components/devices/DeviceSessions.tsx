import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { devicesApi, type DeviceSession } from "../../api/devices";
import { useAuthStore } from "../../store/auth";
import { apiErrorText } from "../../utils/profile";
import Dialog from "../constellation/Dialog";
import { DeviceAuthorizer, DeviceInvitation } from "./DeviceAuthorizer";
import s from "./Pairing.module.css";
import settings from "../SettingsView.module.css";
import LogoutDialog from "../settings/LogoutDialog";

export default function DeviceSessions() {
  const userId = useAuthStore(state => state.user?.id);
  const [devices, setDevices] = useState<DeviceSession[]>([]), [mode, setMode] = useState<"invite" | "claim" | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [leaving, setLeaving] = useState(false);
  const round = useRef(0);
  const load = useCallback(async () => {
    const current = ++round.current;
    try {
      const values = await devicesApi.list();
      if (current === round.current) { setDevices(values.sort((a, b) => Number(b.current) - Number(a.current))); setError(""); }
    } catch (err) { if (current === round.current) setError(apiErrorText(err, "Не удалось загрузить устройства")); }
  }, []);
  useEffect(() => {
    if (!userId) return;
    void load();
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => { round.current++; window.removeEventListener("focus", refresh); };
  }, [load, userId]);
  const revoke = async (device: DeviceSession) => {
    // Своё устройство — обычный выход, с возможностью стереть ключи.
    if (device.current) { setLeaving(true); return; }
    if (!window.confirm(`Завершить сеанс «${device.name}»? На этом устройстве потребуется войти снова.`)) return;
    setBusy(true); setError("");
    try { await devicesApi.revoke(device.id); if (device.current) useAuthStore.getState().logout(); else await load(); }
    catch (err) { setError(apiErrorText(err)); }
    finally { setBusy(false); }
  };
  const revokeOthers = async () => {
    if (!window.confirm("Завершить все остальные сеансы? Для доступа к Quazar на них потребуется войти снова.")) return;
    setBusy(true); setError("");
    try {
      const result = await devicesApi.revokeOthers();
      await useAuthStore.getState().refreshSession(result.access_token);
      await load();
    } catch (err) { setError(apiErrorText(err)); }
    finally { setBusy(false); }
  };
  return <section className={settings.card} aria-label="Устройства">
    <h3 className={settings.sectionTitle}>Устройства</h3>
    <p className={s.hint}>Войдите на телефоне или компьютере через уже открытый Quazar — без номера и пароля.</p>
    <div className={s.actions}>
      <button type="button" className={s.primary} onClick={() => setMode("invite")}>Подключить телефон</button>
      <button type="button" className={s.secondary} onClick={() => setMode("claim")}>Подключить по QR или коду</button>
    </div>
    {devices.map(device => <div className={s.device} key={device.id}>
      <div className={s.deviceInfo}><strong>{device.name}</strong>
        {device.current && <span className={s.current}>Это устройство</span>}
        {device.has_account_key === true && <span className={s.hint}>Ключ переписки есть</span>}
        {device.has_account_key === false && <span className={s.hint}>Без ключа переписки</span>}
        <span className={s.hint}>Активность: {new Date(device.last_seen_at).toLocaleString("ru-RU")}</span>
      </div>
      <button type="button" className={s.secondary} disabled={busy} onClick={() => void revoke(device)}>{device.current ? "Выйти" : "Завершить сеанс"}</button>
    </div>)}
    <p className={s.hint}>Сеансы, созданные до обновления, появятся здесь после подключения к серверу.</p>
    <div className={s.actions}>
      <button type="button" className={s.secondary} disabled={busy} onClick={() => void load()}>Обновить список</button>
      <button type="button" className={s.secondary} disabled={busy || devices.length < 1} onClick={() => void revokeOthers()}>Завершить остальные сеансы</button>
    </div>
    {error && <p className={s.error} role="alert">{error}</p>}
    {leaving && <LogoutDialog onClose={() => setLeaving(false)} />}
    {mode && createPortal(<Dialog title={mode === "invite" ? "Подключить телефон" : "Подключить устройство"} onClose={() => { setMode(null); void load(); }}>
      {mode === "invite" ? <DeviceInvitation /> : <DeviceAuthorizer />}
    </Dialog>, document.body)}
  </section>;
}
