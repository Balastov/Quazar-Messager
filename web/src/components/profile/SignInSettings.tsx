import { useCallback, useEffect, useState } from "react";
import { authApi, type SignInMethods } from "../../api/auth";
import { apiErrorText } from "../../utils/profile";
import { clearReauth, reauthCode, startReauth } from "../../auth/reauth";
import { newPasswordProblem } from "../../auth/password";
import { useAuthStore } from "../../store/auth";
import s from "../SettingsView.module.css";

/** «Вход в аккаунт»: пароль (задать или сменить) и Яндекс ID (привязать или отвязать). */
export default function SignInSettings() {
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Вернулись после подтверждения через Яндекс — сразу форма пароля.
  const [reauth] = useState(reauthCode);
  const reload = useCallback(() => authApi.signInMethods().then(setMethods), []);
  useEffect(() => {
    void reload().catch(() => {});
    if (reauth) setEditing(true);
  }, [reload, reauth]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
      await reload().catch(() => {});
      if (done) setStatus(done);
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!methods) return null;
  const yandexId = methods.identities.find((i) => i.provider === "yandex");
  const showYandex = methods.providers.yandex || !!yandexId;

  return (
    <>
      <h3 className={s.sectionTitle}>Вход в аккаунт</h3>
      <p className={s.hint}>
        Пароль: {methods.has_password ? "задан" : "не задан — задайте, чтобы входить и по номеру с паролем"}
      </p>
      {editing ? (
        <form
          className={s.rowBtns}
          onSubmit={(e) => {
            e.preventDefault();
            const problem = newPasswordProblem(next, confirmation);
            if (problem) { setError(problem); return; }
            void run(async () => {
              const response = await authApi.setPassword(
                next,
                { ...(methods.has_password ? { currentPassword: current } : { reauthCode: reauth ?? undefined }),
                  confirmPassword: confirmation }
              );
              if (response?.access_token) await useAuthStore.getState().refreshSession(response.access_token);
              setMethods((value) => value ? { ...value, has_password: true } : value);
              clearReauth();
              setEditing(false);
              setCurrent("");
              setNext("");
              setConfirmation("");
            }, "Пароль изменён");
          }}
        >
          {methods.has_password && (
            <input
              className={s.input}
              type="password"
              placeholder="Текущий пароль"
              aria-label="Старый пароль"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              disabled={busy}
            />
          )}
          <input
            className={s.input}
            type="password"
            placeholder="Новый пароль, от 8 символов"
            aria-label="Новый пароль"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
            disabled={busy}
            maxLength={72}
          />
          <input className={s.input} type="password" placeholder="Повторите новый пароль" aria-label="Повторите новый пароль"
            value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password"
            required disabled={busy} maxLength={72} />
          {confirmation && next !== confirmation && <p className={s.statusErr} role="alert">Новые пароли не совпадают</p>}
          <button type="submit" className={s.primary} disabled={busy || !!newPasswordProblem(next, confirmation) || (methods.has_password && !current)}>
            Изменить пароль
          </button>
          <button type="button" className={s.secondary} disabled={busy} onClick={() => { setEditing(false); setCurrent(""); setNext(""); setConfirmation(""); }}>
            Отмена
          </button>
        </form>
      ) : (
        <div className={s.rowBtns}>
          <button
            type="button"
            className={s.secondary}
            disabled={busy}
            onClick={() =>
              methods.has_password || reauth
                ? setEditing(true)
                : // Без пароля — сначала подтвердить себя через Яндекс: одной сессии мало.
                  void run(() => startReauth("settings"))
            }
          >
            {methods.has_password ? "Изменить пароль" : "Задать пароль"}
          </button>
        </div>
      )}
      {showYandex && (
        <>
          <p className={s.hint}>
            Яндекс ID:{" "}
            {yandexId ? `привязан${yandexId.email || yandexId.login ? ` (${yandexId.email ?? yandexId.login})` : ""}` : "не привязан"}
          </p>
          <div className={s.rowBtns}>
            {yandexId ? (
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Отвязать Яндекс ID? Входить через него больше не получится.")) {
                    void run(() => authApi.unlink("yandex"), "Яндекс ID отвязан");
                  }
                }}
              >
                Отвязать
              </button>
            ) : (
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    window.location.assign((await authApi.yandexLink()).url);
                  })
                }
              >
                Привязать Яндекс ID
              </button>
            )}
          </div>
        </>
      )}
      {status && <p className={s.hint}>✓ {status}</p>}
      {error && <p className={s.hint} role="alert" style={{ color: "var(--qz-danger)" }}>{error}</p>}
    </>
  );
}
