import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/auth";
import { useAuthStore } from "../store/auth";
import { formatRuPhoneMask, isCompleteRuPhone, toE164Ru } from "../utils/phone";
import s from "./AuthPage.module.css";

type Screen = "welcome" | "login" | "register";

export default function AuthPage() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const setToken = useAuthStore((st) => st.setToken);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const e164 = toE164Ru(phone);
    if (!e164 || !isCompleteRuPhone(phone)) {
      setError("Введите номер в формате +7 (999) 000-00-00");
      return;
    }
    setLoading(true);
    try {
      const data =
        screen === "login"
          ? await authApi.login(e164, password)
          : await authApi.register(username, e164, password);
      await setToken(data.access_token);
      navigate("/");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string | { msg?: string }[] } } })
        ?.response?.data?.detail;
      if (typeof detail === "string") setError(detail);
      else if (Array.isArray(detail) && detail[0]?.msg) setError(detail[0].msg);
      else setError("Что-то пошло не так");
    } finally {
      setLoading(false);
    }
  };

  if (screen === "welcome") {
    return (
      <div className={s.root}>
        <div className={s.card}>
          <img className={s.logoMark} src="/logo-mark.png" alt="" />
          <h1 className={s.brandName}>Quazar</h1>
          <p className={s.tagline}>Общение. Звонки. Люди. В одном пространстве.</p>
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={() => setScreen("login")}>
              Войти
            </button>
            <button type="button" className={s.ghost} onClick={() => setScreen("register")}>
              Создать аккаунт
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.card}>
        <div className={s.formCard}>
          <button type="button" className={s.back} onClick={() => setScreen("welcome")}>
            ← Назад
          </button>
          <h2 className={s.formTitle}>{screen === "login" ? "Вход" : "Регистрация"}</h2>
          <form className={s.form} onSubmit={(e) => void submit(e)}>
            {screen === "register" && (
              <input
                className={s.input}
                placeholder="Имя пользователя"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            )}
            <input
              className={s.input}
              type="tel"
              inputMode="numeric"
              placeholder="+7 (999) 000-00-00"
              value={phone}
              onChange={(e) => setPhone(formatRuPhoneMask(e.target.value))}
              required
              autoComplete="tel"
            />
            <input
              className={s.input}
              type="password"
              placeholder="Пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={screen === "login" ? "current-password" : "new-password"}
            />
            {error && <p className={s.error}>{error}</p>}
            <button
              className={s.submit}
              type="submit"
              disabled={loading || !isCompleteRuPhone(phone)}
            >
              {loading ? "..." : screen === "login" ? "Войти" : "Создать аккаунт"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
