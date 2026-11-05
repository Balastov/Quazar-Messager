import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { parseDeviceLink, type DeviceLink } from "../auth/deviceLink";
import DeviceReceiver from "../components/devices/DeviceReceiver";
import { DeviceAuthorizer } from "../components/devices/DeviceAuthorizer";
import s from "./AuthPage.module.css";
import p from "../components/devices/Pairing.module.css";

export default function DeviceConnectPage() {
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user), token = useAuthStore(state => state.token);
  const [parsed] = useState<{ link?: DeviceLink; error?: string }>(() => {
    try {
      const link = parseDeviceLink(window.location.href);
      return { link };
    } catch { return { error: "Ссылка подключения недействительна. Создайте новый QR-код в Quazar." }; }
  });
  const link = parsed.link;
  useEffect(() => { if (link) window.history.replaceState(null, "", "/connect"); }, [link]);
  return <div className={s.root}><div className={s.card}><div className={s.formCard}>
    <h1 className={s.formTitle}>Подключение к Quazar</h1>
    {parsed.error && <p className={p.error} role="alert">{parsed.error}</p>}
    {link?.kind === "invite" && (token ? <>
      <p className={p.hint}>Вы уже вошли как {user?.display_name || user?.username || "пользователь"}. Чтобы подключить другой аккаунт, сначала выйдите из текущего.</p>
      <button type="button" className={p.primary} onClick={() => navigate("/")}>Открыть Quazar</button>
      <button type="button" className={p.secondary} onClick={() => useAuthStore.getState().logout()}>Выйти из текущего аккаунта</button>
    </> : <DeviceReceiver invite={link} onDone={() => navigate("/", { replace: true })} />)}
    {link?.kind === "request" && (token ? <DeviceAuthorizer link={link} /> : <>
      <p className={p.hint}>Этот QR нужно открыть на устройстве, где вы уже вошли в Quazar. В его настройках выберите «Устройства → Подключить по QR или коду».</p>
      <button type="button" className={p.secondary} onClick={() => navigate("/auth")}>На страницу входа</button>
    </>)}
    {link?.kind === "request" && token && <button type="button" className={p.secondary} onClick={() => navigate("/")}>Вернуться в Quazar</button>}
    {!link && <button type="button" className={p.secondary} onClick={() => navigate(token ? "/" : "/auth")}>Вернуться в Quazar</button>}
  </div></div></div>;
}
