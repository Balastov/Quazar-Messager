/**
 * «Войти в Padma через Квазар» — страница, на которую Padma отправляет человека
 * (/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…).
 *
 * 1. Проверяем клиента и адрес возврата у сервера. Ошибка — показываем её и никуда не ведём.
 * 2. Не вошёл — на /auth; после входа вернём сюда же (auth/returnAfterLogin.ts).
 * 3. Телефон не подтверждён — подтверждение звонком, без него код не выдаётся.
 * 4. «Войти в Padma как …» — код выдаётся только по нажатию «Продолжить».
 *
 * Внутри чужого сайта (iframe) страница кнопок не показывает: иначе нажатие можно подстроить.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { oauthProviderApi, type AuthorizeRequest } from "../api/oauthProvider";
import type { User } from "../api/types";
import { usersApi } from "../api/users";
import { clearReturn, rememberReturn } from "../auth/returnAfterLogin";
import PhoneVerification from "../components/profile/PhoneVerification";
import { useAuthStore } from "../store/auth";
import { apiErrorText } from "../utils/profile";
import s from "./AuthPage.module.css";

type Check = { state: "checking" } | { state: "bad"; message: string } | { state: "ok"; name: string };

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

function framed(): boolean {
  try { return window.top !== window.self; } catch { return true; }
}

/** Параметры из адреса; null — запрос составлен неверно (тогда никуда не ведём). */
export function readRequest(search: string): AuthorizeRequest | null {
  const params = new URLSearchParams(search);
  const request = {
    client_id: params.get("client_id") ?? "",
    redirect_uri: params.get("redirect_uri") ?? "",
    state: params.get("state") ?? "",
    code_challenge: params.get("code_challenge") ?? "",
    code_challenge_method: params.get("code_challenge_method") ?? "",
  };
  if (params.get("response_type") !== "code" || !request.client_id || !request.redirect_uri || !request.state
    || request.code_challenge_method !== "S256" || !CHALLENGE.test(request.code_challenge)) return null;
  return request;
}

/** Адрес возврата с добавленными параметрами (у адреса уже может быть свой query). */
export function withParams(uri: string, values: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

/** «+7 ••• •••-••-12», «+33 ••• ••78» — номер узнаваемо, но не целиком: код страны и две последние цифры. */
export function maskedPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 2) return "";
  if (phone!.startsWith("+7") || !phone!.startsWith("+")) return `+7 ••• •••-••-${digits.slice(-2)}`;
  const code = parsePhoneNumberFromString(phone!)?.countryCallingCode;
  return code ? `+${code} ••• ••${digits.slice(-2)}` : `+••• ••${digits.slice(-2)}`;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={s.root}><div className={s.card}><div className={s.formCard}>
    <h2 className={s.formTitle}>{title}</h2>
    {children}
  </div></div></div>;
}

export default function OAuthAuthorizePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = useAuthStore(st => st.token);
  const storedUser = useAuthStore(st => st.user);
  const setUser = useAuthStore(st => st.setUser);
  const logout = useAuthStore(st => st.logout);
  const [freshUser, setFreshUser] = useState<User | null>(null);
  const request = useMemo(() => readRequest(location.search), [location.search]);
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPhone, setNeedsPhone] = useState(false);
  const inFrame = framed();

  useEffect(() => {
    if (!request) { setCheck({ state: "bad", message: "Ссылка для входа составлена неверно. Вернитесь на сайт и попробуйте ещё раз." }); return; }
    let active = true;
    setCheck({ state: "checking" });
    oauthProviderApi.client(request.client_id, request.redirect_uri)
      .then(result => { if (active) setCheck({ state: "ok", name: result.name }); })
      .catch(err => { if (active) setCheck({ state: "bad", message: apiErrorText(err, "Не удалось проверить, куда вы входите") }); });
    return () => { active = false; };
  }, [request]);

  // Профиль заново: подтверждение телефона могло пройти на другом устройстве.
  const reload = useCallback(() => {
    void usersApi.me().then(me => { setFreshUser(me); setUser(me); }).catch(() => {});
  }, [setUser]);
  useEffect(() => {
    if (!token) return;
    // Вошли — запоминать возврат больше не нужно: параметры и так в адресе этой вкладки.
    clearReturn();
    reload();
  }, [token, reload]);
  const user = freshUser && freshUser.id === storedUser?.id ? freshUser : storedUser ?? freshUser;

  if (inFrame) return <Shell title="Вход через Quazar">
    <p className={s.lead}>Эту страницу нельзя открыть внутри другого сайта. Откройте её в отдельной вкладке.</p>
  </Shell>;
  if (check.state === "checking") return <Shell title="Вход через Quazar"><p className={s.lead}>Проверяем…</p></Shell>;
  if (check.state === "bad" || !request) return <Shell title="Не получилось войти">
    <p className={s.lead}>{check.state === "bad" ? check.message : "Ссылка для входа составлена неверно."}</p>
  </Shell>;

  const name = check.name;
  if (!token) {
    rememberReturn(location.pathname + location.search, name);
    return <Navigate to="/auth" replace />;
  }
  if (!user) return <Shell title={`Вход в ${name}`}><p className={s.lead}>Загружаем профиль…</p></Shell>;

  const cancel = () => {
    clearReturn();
    window.location.assign(withParams(request.redirect_uri, { error: "access_denied", state: request.state }));
  };
  const another = () => {
    rememberReturn(location.pathname + location.search, name);
    setFreshUser(null);
    logout("switch_account");
    navigate("/auth", { replace: true });
  };

  if (!user.phone_verified_at || needsPhone) return <Shell title={`Вход в ${name}`}>
    <p className={s.lead}>{name} принимает только аккаунты с подтверждённым телефоном. Подтвердите номер — это займёт минуту.</p>
    {user.phone && <PhoneVerification phone={user.phone} account onVerified={() => { setNeedsPhone(false); reload(); }} />}
    <button type="button" className={s.ghost} onClick={cancel}>Отмена</button>
  </Shell>;

  const proceed = async () => {
    setBusy(true); setError(null);
    try {
      const { redirect_to } = await oauthProviderApi.authorize(request);
      clearReturn();
      window.location.assign(redirect_to);
    } catch (err) {
      const text = apiErrorText(err, "Не удалось войти");
      if (text === "phone_unverified") setNeedsPhone(true);
      else setError(text);
      setBusy(false);
    }
  };

  return <Shell title={`Вход в ${name}`}>
    <p className={s.lead}>Войти в {name} как <b>{user.display_name || user.username}</b>{user.phone ? `, ${maskedPhone(user.phone)}` : ""}?</p>
    <p className={s.hint}>{name} получит ваше имя, ник и подтверждённый номер телефона.</p>
    {error && <div className={s.error} role="alert">{error}</div>}
    <button type="button" className={s.submit} disabled={busy} onClick={() => void proceed()}>{busy ? "Входим…" : "Продолжить"}</button>
    <button type="button" className={s.ghost} disabled={busy} onClick={cancel}>Отмена</button>
    <button type="button" className={s.ghost} disabled={busy} onClick={another}>Войти другим аккаунтом</button>
  </Shell>;
}
