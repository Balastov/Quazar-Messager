import { useCallback, useEffect, useState } from "react";
import { authApi, type SignInMethods } from "../../api/auth";
import { apiErrorText } from "../../utils/profile";
import { REAUTH_KEY } from "../../pages/YandexAuthPage";
import s from "../SettingsView.module.css";

/** «Вход в аккаунт»: пароль (задать или сменить) и Яндекс ID (привязать или отвязать). */
export default function SignInSettings() {
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Вернулись после подтверждения через Яндекс — сразу форма пароля.
  const [reauth] = useState(() => sessionStorage.getItem(REAUTH_KEY));
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
      await reload();
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
            void run(async () => {
              await authApi.setPassword(
                next,
                methods.has_password ? { currentPassword: current } : { reauthCode: reauth ?? undefined }
              );
              sessionStorage.removeItem(REAUTH_KEY);
              setEditing(false);
              setCurrent("");
              setNext("");
            }, "Пароль сохранён");
          }}
        >
          {methods.has_password && (
            <input
              className={s.input}
              type="password"
              placeholder="Текущий пароль"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          )}
          <input
            className={s.input}
            type="password"
            placeholder="Новый пароль, от 8 символов"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
          <button type="submit" className={s.primary} disabled={busy || next.length < 8}>
            Сохранить
          </button>
          <button type="button" className={s.secondary} onClick={() => setEditing(false)}>
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
                  void run(async () => window.location.assign((await authApi.yandexReauth()).url))
            }
          >
            {methods.has_password ? "Сменить пароль" : "Задать пароль"}
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
      {error && <p className={s.hint} style={{ color: "var(--qz-danger)" }}>{error}</p>}
    </>
  );
}
