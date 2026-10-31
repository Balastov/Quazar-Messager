import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi, type YandexProfile } from "../api/auth";
import { useAuthStore } from "../store/auth";
import { useUiStore } from "../store/ui";
import { formatRuPhoneMask, isCompleteRuPhone, toE164Ru } from "../utils/phone";
import { apiErrorText, USERNAME_MAX } from "../utils/profile";
import { useUsernameCheck } from "../components/profile/useUsernameCheck";
import PhoneVisibilityChoice from "../components/profile/PhoneVisibilityChoice";
import s from "./AuthPage.module.css";

/** Код подтверждения через Яндекс — его заберёт «Вход в аккаунт» в настройках. */
export const REAUTH_KEY = "quazar.yandexReauth";

const ERRORS: Record<string, string> = {
  mismatch: "Подтвердить можно только тем Яндекс ID, что привязан к аккаунту.",
  denied: "Вход через Яндекс отменён.",
  expired: "Время входа истекло — попробуйте ещё раз.",
  yandex: "Яндекс не ответил — попробуйте ещё раз через минуту.",
};

const LINKED: Record<string, string> = {
  ok: "Яндекс ID привязан — теперь можно входить через него.",
  taken: "Этот Яндекс ID уже привязан к другому аккаунту Quazar.",
  other: "К аккаунту уже привязан другой Яндекс ID — сначала отвяжите его в настройках.",
};

/** Параметры после «#» — их кладёт сервер, возвращая человека из Яндекса. */
function readFragment(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
}

// Код одноразовый: StrictMode в разработке вызывает эффект дважды — меняем его один раз.
let exchanged: string | null = null;

/** Возврат из Яндекса: вход, шаг «Почти готово» для новичка, итог привязки или ошибка. */
export default function YandexAuthPage() {
  const navigate = useNavigate();
  const token = useAuthStore((st) => st.token);
  const setToken = useAuthStore((st) => st.setToken);
  const [fragment] = useState(readFragment);
  const [profile, setProfile] = useState<YandexProfile | null>(null);
  const [error, setError] = useState<string | null>(fragment.error ? ERRORS[fragment.error] ?? ERRORS.expired : null);
  const started = useRef(false);

  useEffect(() => {
    // Код в адресной строке не нужен — убираем, чтобы не попал в историю и закладки.
    window.history.replaceState(null, "", window.location.pathname);
    const code = fragment.code;
    if (!code || started.current || exchanged === code) return;
    started.current = true;
    exchanged = code;
    authApi
      .yandexExchange(code)
      .then(async (res) => {
        if (res.status === "login") {
          await setToken(res.access_token);
          navigate("/", { replace: true });
        } else {
          setProfile(res.profile);
        }
      })
      .catch((err) => setError(apiErrorText(err)));
  }, [fragment.code, navigate, setToken]);

  if (fragment.reauth) {
    sessionStorage.setItem(REAUTH_KEY, fragment.reauth);
    return (
      <Shell title="Подтверждено">
        <p className={s.lead}>Это вы — теперь можно задать пароль в настройках, раздел «Вход в аккаунт».</p>
        <button
          type="button"
          className={s.submit}
          onClick={() => {
            useUiStore.getState().setTab("settings");
            navigate("/", { replace: true });
          }}
        >
          Задать пароль
        </button>
      </Shell>
    );
  }

  if (fragment.linked) {
    return (
      <Shell title="Яндекс ID">
        <p className={s.lead}>{LINKED[fragment.linked] ?? LINKED.taken}</p>
        <button type="button" className={s.submit} onClick={() => navigate("/", { replace: true })}>
          {token ? "Продолжить" : "Ко входу"}
        </button>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell title="Не получилось войти">
        <p className={s.lead}>{error}</p>
        <button type="button" className={s.submit} onClick={() => navigate("/auth", { replace: true })}>
          Ко входу
        </button>
      </Shell>
    );
  }

  if (!profile) {
    return (
      <Shell title="Входим…">
        <p className={s.lead}>Получаем данные из Яндекса.</p>
      </Shell>
    );
  }

  return <AlmostDone code={fragment.code!} profile={profile} />;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={s.root}>
      <div className={s.card}>
        <div className={s.formCard}>
          <h2 className={s.formTitle}>{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Новичок: ник и телефон (обязательны в Quazar), остальное подставлено из Яндекса. */
function AlmostDone({ code, profile }: { code: string; profile: YandexProfile }) {
  const navigate = useNavigate();
  const setToken = useAuthStore((st) => st.setToken);
  const [username, setUsername] = useState(profile.username ?? "");
  const [phone, setPhone] = useState(profile.phone ? formatRuPhoneMask(profile.phone) : "+7");
  const [firstName, setFirstName] = useState(profile.first_name ?? "");
  const [lastName, setLastName] = useState(profile.last_name ?? "");
  const [phoneDiscoverable, setPhoneDiscoverable] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const usernameCheck = useUsernameCheck(username);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!isCompleteRuPhone(phone)) return setError("Введите номер в формате +7 (999) 000-00-00");
    if (phoneDiscoverable === null) return setError("Выберите, можно ли найти вас по номеру");
    setLoading(true);
    try {
      const data = await authApi.yandexComplete({
        code,
        username: username.trim().replace(/^@/, ""),
        phone: toE164Ru(phone)!,
        phone_discoverable: phoneDiscoverable,
        first_name: firstName.trim() || null,
        last_name: lastName.trim() || null,
      });
      await setToken(data.access_token);
      navigate("/", { replace: true });
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Shell title="Почти готово">
      <p className={s.lead}>
        Вы вошли через Яндекс ID. Осталось выбрать никнейм и указать телефон — по ним вас найдут знакомые.
        {profile.email ? ` Почта ${profile.email} привяжется к аккаунту.` : ""}
      </p>
      <form className={s.form} onSubmit={(e) => void submit(e)}>
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
              autoFocus={!profile.username}
            />
          </div>
          <p className={usernameCheck.state === "bad" ? s.hintBad : usernameCheck.state === "ok" ? s.hintOk : s.hint}>
            {usernameCheck.state === "bad"
              ? usernameCheck.message
              : usernameCheck.state === "ok"
                ? "Никнейм свободен"
                : usernameCheck.state === "checking"
                  ? "Проверяем…"
                  : "Латиницей: по нему вас найдут и @упомянут"}
          </p>
        </div>
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
        <div className={s.pair}>
          <input
            className={s.input}
            placeholder="Имя"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            maxLength={64}
            autoComplete="given-name"
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
        <div className={s.choice}>
          <PhoneVisibilityChoice value={phoneDiscoverable} onChange={setPhoneDiscoverable} />
        </div>
        {error && <p className={s.error}>{error}</p>}
        <button
          className={s.submit}
          type="submit"
          disabled={loading || usernameCheck.state !== "ok" || !isCompleteRuPhone(phone) || phoneDiscoverable === null}
        >
          {loading ? "..." : "Готово"}
        </button>
        <p className={s.hint}>Уже есть аккаунт Quazar? Войдите в него по паролю и привяжите Яндекс в настройках.</p>
      </form>
    </Shell>
  );
}
