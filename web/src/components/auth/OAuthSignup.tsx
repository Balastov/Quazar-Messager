/**
 * «Регистрация для Padma» (prompt=create, docs/PADMA-SSO.md, этап 3.1): телефон → подтверждение →
 * фамилия и имя. Никнейм сервер подберёт сам, номер скрыт от поиска, пароля нет.
 * После создания аккаунта страница авторизации покажет обычное «Войти в Padma как …».
 */
import { useState } from "react";
import { oauthProviderApi, type AuthorizeRequest } from "../../api/oauthProvider";
import { useAuthStore } from "../../store/auth";
import { formatPhoneDisplay, formatPhoneInput, toE164 } from "../../utils/phone";
import { apiErrorText } from "../../utils/profile";
import PhoneCountryHint from "../profile/PhoneCountryHint";
import PhoneVerification from "../profile/PhoneVerification";
import s from "../../pages/AuthPage.module.css";

export default function OAuthSignup({ request, name, onSignIn, onCancel }: {
  request: AuthorizeRequest; name: string; onSignIn: () => void; onCancel: () => void;
}) {
  const setToken = useAuthStore(st => st.setToken);
  const [phone, setPhone] = useState("+7");
  const [proof, setProof] = useState<string>();
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const e164 = toE164(phone);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!e164 || !proof || !lastName.trim() || !firstName.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const { access_token } = await oauthProviderApi.register({
        client_id: request.client_id, redirect_uri: request.redirect_uri, phone: e164,
        phone_verification_token: proof, last_name: lastName.trim(), first_name: firstName.trim(),
      });
      await setToken(access_token);
    } catch (err) {
      const text = apiErrorText(err, "Не удалось создать аккаунт");
      setError(text);
      // Подтверждение просрочено или уже израсходовано — номер подтверждают заново.
      if (/Подтвердите телефон|уже зарегистрирован/.test(text)) setProof(undefined);
      setBusy(false);
    }
  };

  return <>
    <p className={s.lead}>Аккаунт Quazar для входа в {name}: подтвердите телефон и укажите фамилию и имя.</p>
    <form className={s.form} onSubmit={event => void create(event)}>
      {proof && e164 ? <>
        <p className={s.hint}>✓ Телефон {formatPhoneDisplay(e164)} подтверждён</p>
        <input className={s.input} placeholder="Фамилия" aria-label="Фамилия" value={lastName} maxLength={64} required
          autoComplete="family-name" onChange={event => setLastName(event.target.value)} autoFocus />
        <input className={s.input} placeholder="Имя" aria-label="Имя" value={firstName} maxLength={64} required
          autoComplete="given-name" onChange={event => setFirstName(event.target.value)} />
        <p className={s.hint}>Никнейм Quazar подберём по фамилии и имени — его можно сменить в настройках. По номеру вас не найдут.</p>
        <button className={s.submit} type="submit" disabled={busy || !lastName.trim() || !firstName.trim()}>
          {busy ? "Создаём аккаунт…" : "Создать аккаунт"}
        </button>
      </> : <>
        <input className={s.input} type="tel" inputMode="tel" aria-label="Номер телефона" placeholder="+7 (999) 000-00-00" value={phone}
          autoComplete="tel" required onChange={event => { setPhone(formatPhoneInput(event.target.value)); setProof(undefined); setError(""); }} />
        <PhoneCountryHint phone={phone} className={s.hint} />
        <PhoneVerification key={e164 ?? ""} phone={e164 ?? ""} disabled={!e164 || busy} onVerified={setProof} />
        {!e164 && <p className={s.hint}>Введите номер полностью, чтобы продолжить.</p>}
      </>}
      {error && <div className={s.error} role="alert">{error}</div>}
    </form>
    <button type="button" className={s.ghost} disabled={busy} onClick={onSignIn}>Уже есть аккаунт Quazar — войти</button>
    <button type="button" className={s.ghost} disabled={busy} onClick={onCancel}>Отмена</button>
  </>;
}
