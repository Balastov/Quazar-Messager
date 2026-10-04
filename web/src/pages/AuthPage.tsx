import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/auth";
import { useAuthStore } from "../store/auth";
import { formatRuPhoneMask, isCompleteRuPhone, toE164Ru } from "../utils/phone";
import s from "./AuthPage.module.css";

export default function AuthPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const setToken = useAuthStore((s) => s.setToken);
  const navigate = useNavigate();

  const onPhoneChange = (raw: string) => {
    setPhone(formatRuPhoneMask(raw));
  };

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
        mode === "login"
          ? await authApi.login(e164, password)
          : await authApi.register(username, e164, password);
      await setToken(data.access_token);
      navigate("/");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string | { msg?: string }[] } } })
        ?.response?.data?.detail;
      if (typeof detail === "string") {
        setError(detail);
      } else if (Array.isArray(detail) && detail[0]?.msg) {
        setError(detail[0].msg);
      } else {
        setError("Что-то пошло не так");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s.root}>
      <div className={s.card}>
        <div className={s.brand}>
          <img className={s.logoImg} src="/logo-full.png" alt="Quazar" />
        </div>
        <div className={s.tabs}>
          <button className={mode === "login" ? s.activeTab : s.tab} onClick={() => setMode("login")}>
            Войти
          </button>
          <button
            className={mode === "register" ? s.activeTab : s.tab}
            onClick={() => setMode("register")}
          >
            Регистрация
          </button>
        </div>

        <form onSubmit={submit} className={s.form}>
          {mode === "register" && (
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
            onChange={(e) => onPhoneChange(e.target.value)}
            onFocus={() => {
              if (!phone || phone === "") setPhone("+7");
            }}
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
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {error && <p className={s.error}>{error}</p>}
          <button className={s.submit} type="submit" disabled={loading || !isCompleteRuPhone(phone)}>
            {loading ? "..." : mode === "login" ? "Войти" : "Создать аккаунт"}
          </button>
        </form>
      </div>
    </div>
  );
}
