import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/auth";
import { phoneVerificationApi } from "../api/phoneVerification";
import { useAuthStore } from "../store/auth";
import { formatRuPhoneMask, isCompleteRuPhone, toE164Ru } from "../utils/phone";
import { apiErrorText, USERNAME_MAX } from "../utils/profile";
import { useUsernameCheck } from "../components/profile/useUsernameCheck";
import PhoneVisibilityChoice from "../components/profile/PhoneVisibilityChoice";
import ForgotPasswordDialog from "../components/profile/ForgotPasswordDialog";
import PhoneVerification from "../components/profile/PhoneVerification";
import s from "./AuthPage.module.css";
import { desktop } from "../platform/desktop";
import { startDesktopYandexLogin } from "../auth/desktopYandex";

export default function AuthPage() {
  const [screen, setScreen] = useState<"welcome" | "login" | "register" | "profile">("welcome");
  const [phone, setPhone] = useState("+7");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [passwordAllowed, setPasswordAllowed] = useState(false);
  const [proof, setProof] = useState<string>();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [discoverable, setDiscoverable] = useState<boolean | null>(null);
  const [yandex, setYandex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState(false);
  const [round, setRound] = useState(0);
  const setToken = useAuthStore(st => st.setToken);
  const navigate = useNavigate();
  const check = useUsernameCheck(screen === "profile" ? username : "");
  const e164 = isCompleteRuPhone(phone) ? toE164Ru(phone) : null;
  useEffect(() => { void authApi.providers().then(p => setYandex(p.yandex)).catch(() => {}); }, []);
  useEffect(() => {
    let active = true;
    setPasswordAllowed(false); setLegacy(false); setPassword("");
    if (!e164 || screen !== "login") return;
    const timer = setTimeout(() => {
      void authApi.phoneOptions(e164).then(result => { if (active) setPasswordAllowed(result.password_login_allowed); })
        .catch(() => { if (active) setError("Не удалось проверить способы входа. Повторите попытку."); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [e164, screen]);
  const go = (value: typeof screen) => { setError(""); setScreen(value); setLegacy(false); };
  const finish = async (token: string) => { await setToken(token); navigate("/"); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    if (!e164) return;
    setBusy(true);
    try {
      if (screen === "login" && legacy) await finish((await authApi.login(e164, password)).access_token);
      else if (screen === "profile") {
        if (!proof) { go("register"); return; }
        if (discoverable === null) { setError("Выберите, можно ли найти вас по номеру"); return; }
        await finish((await authApi.register({ username: username.trim().replace(/^@/, ""), phone: e164,
          phone_discoverable: discoverable, phone_verification_token: proof, first_name: firstName, last_name: lastName, email })).access_token);
      }
    } catch (err) {
      const text = apiErrorText(err); setError(text);
      if (screen === "login" && legacy && text.startsWith("Телефон подтверждён.")) {
        setLegacy(false); setPasswordAllowed(false); setPassword("");
      }
      if (/Подтвердите телефон/.test(text)) { setProof(undefined); setScreen("register"); }
    } finally { setBusy(false); }
  };
  const yandexButton = yandex && <><div className={s.or}>или</div><a className={s.yandex} href={authApi.yandexStartUrl}
    onClick={event => { if (desktop()) { event.preventDefault(); void startDesktopYandexLogin().catch(err => setError(apiErrorText(err))); } }}>
    <span className={s.yandexMark} aria-hidden>Я</span>Войти с Яндекс ID</a></>;
  if (screen === "welcome") return <div className={s.root}><div className={s.card}>
    <img className={s.logoMark} src="/logo-mark.png?v=neon-q-2" alt="" />
    <h1 className={s.brandName}>Quazar</h1><p className={s.tagline}>Общение. Звонки. Люди. В одном пространстве.</p>
    <div className={s.actions}><button type="button" className={s.primary} onClick={() => go("login")}>Войти</button>
      <button type="button" className={s.ghost} onClick={() => go("register")}>Создать аккаунт</button>{yandexButton}</div>
  </div></div>;
  return <div className={s.root}><div className={s.card}><div className={s.formCard}>
    <button type="button" className={s.back} onClick={() => go(screen === "profile" ? "register" : "welcome")}>← Назад</button>
    <h2 className={s.formTitle}>{screen === "login" ? "Вход" : screen === "profile" ? "Как вас представить?" : "Регистрация"}</h2>
    {screen === "login" && !legacy && <p className={s.lead}>Введите номер телефона и нажмите «Войти звонком». Если вы уже подтвердили номер, для входа нужен новый звонок.</p>}
    {screen === "register" && <p className={s.lead}>Сначала подтвердите телефон. Пароль для регистрации не нужен.</p>}
    <form className={s.form} onSubmit={event => void submit(event)}>
      {screen === "profile" ? <>
        <p className={s.hint}>✓ Телефон {phone} подтверждён</p>
        <div className={s.nickField}><span className={s.nickAt}>@</span><input className={`${s.input} ${s.nickInput}`}
          placeholder="никнейм" value={username} onChange={event => setUsername(event.target.value.replace(/\s/g, ""))}
          maxLength={USERNAME_MAX + 1} required autoComplete="username" autoCapitalize="none" spellCheck={false} /></div>
        <p className={check.state === "bad" ? s.hintBad : s.hint}>{check.state === "bad" ? check.message : "Латиницей: по нему вас найдут и @упомянут"}</p>
        <div className={s.pair}><input className={s.input} placeholder="Имя" value={firstName} onChange={e => setFirstName(e.target.value)} maxLength={64} autoComplete="given-name" />
          <input className={s.input} placeholder="Фамилия" value={lastName} onChange={e => setLastName(e.target.value)} maxLength={64} autoComplete="family-name" /></div>
        <input className={s.input} type="email" placeholder="Почта — необязательно" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} autoComplete="email" />
        <PhoneVisibilityChoice value={discoverable} onChange={setDiscoverable} disabled={busy} />
        <button className={s.submit} type="submit" disabled={busy || check.state !== "ok" || discoverable === null}>{busy ? "Создаём аккаунт…" : "Создать аккаунт"}</button>
      </> : <>
        <input className={s.input} type="tel" inputMode="numeric" aria-label="Номер телефона" placeholder="+7 (999) 000-00-00" value={phone}
          onChange={event => { setPhone(formatRuPhoneMask(event.target.value)); setProof(undefined); setError(""); }} required autoComplete="tel" />
        {screen === "login" && legacy ? <>
          <input className={s.input} type="password" placeholder="Пароль" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password" />
          <button className={s.submit} type="submit" disabled={busy || !e164 || !password}>Войти</button>
          <button type="button" className={s.skip} onClick={() => setForgot(true)}>Забыл пароль</button>
          <button type="button" className={s.skip} onClick={() => setLegacy(false)}>Вернуться ко входу звонком</button>
        </> : <>
          <PhoneVerification key={`${screen}:${e164}:${round}`} phone={e164 ?? ""} account={screen === "login" ? "login" : false}
            disabled={!e164 || busy}
            proof={screen === "register" ? proof : undefined} buttonLabel={screen === "login" ? "Войти звонком" : "Подтвердить телефон звонком"}
            onVerified={token => {
              if (screen === "register") { setProof(token); go("profile"); }
              else {
                setBusy(true);
                void phoneVerificationApi.completeLogin(token).then(result => finish(result.access_token)).catch(err => {
                  setError(apiErrorText(err));
                  sessionStorage.removeItem(`quazar-phone-check:login:${e164}`); setRound(value => value + 1);
                }).finally(() => setBusy(false));
              }
            }} />
          {!e164 && <p className={s.hint}>Введите номер полностью, чтобы продолжить.</p>}
          {screen === "register" && proof && <button className={s.submit} type="button" onClick={() => go("profile")}>Продолжить</button>}
          {screen === "login" && passwordAllowed && <button type="button" className={s.skip} onClick={() => setLegacy(true)}>Войти паролем — старый аккаунт</button>}
        </>}
      </>}
      {error && <p className={s.error} role="alert">{error}</p>}
    </form>{yandexButton}
    {forgot && <ForgotPasswordDialog initialLogin={e164 ?? ""} onClose={() => setForgot(false)} />}
  </div></div></div>;
}
