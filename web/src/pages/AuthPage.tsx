import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/auth";
import { useAuthStore } from "../store/auth";
import { formatRuPhoneMask, isCompleteRuPhone, toE164Ru } from "../utils/phone";
import { apiErrorText, USERNAME_MAX } from "../utils/profile";
import { useUsernameCheck } from "../components/profile/useUsernameCheck";
import PhoneVisibilityChoice from "../components/profile/PhoneVisibilityChoice";
import s from "./AuthPage.module.css";

// register — обязательное (телефон, никнейм, пароль); about — предлагаем имя и почту.
type Screen = "welcome" | "login" | "register" | "about";

export default function AuthPage() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  // Без значения по умолчанию: «Да» или «Нет» человек выбирает сам.
  const [phoneDiscoverable, setPhoneDiscoverable] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const usernameCheck = useUsernameCheck(screen === "register" ? username : "");

  const setToken = useAuthStore((st) => st.setToken);
  const navigate = useNavigate();

  const go = (next: Screen) => {
    setError("");
    setScreen(next);
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const e164 = toE164Ru(phone);
    if (!e164 || !isCompleteRuPhone(phone)) {
      setError("Введите номер в формате +7 (999) 000-00-00");
      return;
    }
    setLoading(true);
    try {
      const data = await authApi.login(e164, password);
      await setToken(data.access_token);
      navigate("/");
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  };

  const toAbout = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!isCompleteRuPhone(phone)) return setError("Введите номер в формате +7 (999) 000-00-00");
    if (usernameCheck.state === "bad") return setError(usernameCheck.message);
    if (password.length < 8) return setError("Пароль — не короче 8 символов");
    if (phoneDiscoverable === null) return setError("Выберите, можно ли найти вас по номеру");
    setScreen("about");
  };

  const register = async (withAbout: boolean) => {
    setError("");
    setLoading(true);
    try {
      const data = await authApi.register({
        username: username.trim().replace(/^@/, ""),
        phone: toE164Ru(phone)!,
        password,
        phone_discoverable: phoneDiscoverable!,
        ...(withAbout ? { first_name: firstName, last_name: lastName, email } : {}),
      });
      await setToken(data.access_token);
      navigate("/");
    } catch (err) {
      const text = apiErrorText(err);
      setError(text);
      // Номер или никнейм успели занять — это поля первого шага.
      if (/номер|никнейм|Phone|ароль/i.test(text)) setScreen("register");
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
            <button type="button" className={s.primary} onClick={() => go("login")}>
              Войти
            </button>
            <button type="button" className={s.ghost} onClick={() => go("register")}>
              Создать аккаунт
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "about") {
    return (
      <div className={s.root}>
        <div className={s.card}>
          <div className={s.formCard}>
            <button type="button" className={s.back} onClick={() => go("register")}>
              ← Назад
            </button>
            <h2 className={s.formTitle}>Как вас представить?</h2>
            <p className={s.lead}>
              Имя и фамилию увидят собеседники вместо @{username.trim().replace(/^@/, "")}. Почта
              пригодится, чтобы восстановить доступ. Всё это можно указать и позже в настройках.
            </p>
            <form
              className={s.form}
              onSubmit={(e) => {
                e.preventDefault();
                void register(true);
              }}
            >
              <div className={s.pair}>
                <input
                  className={s.input}
                  placeholder="Имя"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={64}
                  autoComplete="given-name"
                  autoFocus
                />
                <input
                  className={s.input}
                  placeholder="Фамилия"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  maxLength={64}
                  autoComplete="family-name"
                />
              </div>
              <input
                className={s.input}
                type="email"
                placeholder="Электронная почта"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                autoComplete="email"
              />
              {error && <p className={s.error}>{error}</p>}
              <button
                className={s.submit}
                type="submit"
                disabled={loading || !(firstName.trim() || lastName.trim() || email.trim())}
              >
                {loading ? "..." : "Готово"}
              </button>
              <button type="button" className={s.skip} disabled={loading} onClick={() => void register(false)}>
                Пропустить
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const isLogin = screen === "login";
  return (
    <div className={s.root}>
      <div className={s.card}>
        <div className={s.formCard}>
          <button type="button" className={s.back} onClick={() => go("welcome")}>
            ← Назад
          </button>
          <h2 className={s.formTitle}>{isLogin ? "Вход" : "Регистрация"}</h2>
          <form className={s.form} onSubmit={(e) => (isLogin ? void login(e) : toAbout(e))}>
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
            {!isLogin && (
              <div>
                <div className={s.nickField}>
                  <span className={s.nickAt}>@</span>
                  <input
                    className={`${s.input} ${s.nickInput}`}
                    placeholder="никнейм"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
                    maxLength={USERNAME_MAX + 1}
                    required
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
                <p
                  className={
                    usernameCheck.state === "bad" ? s.hintBad : usernameCheck.state === "ok" ? s.hintOk : s.hint
                  }
                >
                  {usernameCheck.state === "bad"
                    ? usernameCheck.message
                    : usernameCheck.state === "ok"
                      ? "Никнейм свободен"
                      : usernameCheck.state === "checking"
                        ? "Проверяем…"
                        : "Латиницей: по нему вас найдут и @упомянут"}
                </p>
              </div>
            )}
            <input
              className={s.input}
              type="password"
              placeholder="Пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={isLogin ? "current-password" : "new-password"}
            />
            {!isLogin && (
              <div className={s.choice}>
                <PhoneVisibilityChoice value={phoneDiscoverable} onChange={setPhoneDiscoverable} />
              </div>
            )}
            {error && <p className={s.error}>{error}</p>}
            <button
              className={s.submit}
              type="submit"
              disabled={
                loading ||
                !isCompleteRuPhone(phone) ||
                (!isLogin && (usernameCheck.state !== "ok" || password.length < 8 || phoneDiscoverable === null))
              }
            >
              {loading ? "..." : isLogin ? "Войти" : "Далее"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
