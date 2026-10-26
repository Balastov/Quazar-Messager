import { useEffect, useState } from "react";
import { usersApi } from "../../api/users";
import type { User } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { apiErrorText, USERNAME_MAX } from "../../utils/profile";
import { useUsernameCheck } from "./useUsernameCheck";
import base from "../SettingsView.module.css";
import s from "./ProfileEditor.module.css";

type Field = "username" | "first_name" | "last_name" | "email";

function initial(user: User): Record<Field, string> {
  return {
    username: user.username,
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    email: user.email ?? "",
  };
}

/** Никнейм, имя, фамилия и почта в настройках. Сохраняет только изменённые поля. */
export default function ProfileEditor({ user }: { user: User }) {
  const setUser = useAuthStore((st) => st.setUser);
  const [form, setForm] = useState(() => initial(user));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usernameCheck = useUsernameCheck(form.username, user.username);

  // Профиль поменяли на другом устройстве — подтягиваем, если здесь ничего не правят.
  useEffect(() => setForm(initial(user)), [user]);

  const saved = initial(user);
  const changed = (Object.keys(form) as Field[]).filter((k) => form[k].trim() !== saved[k]);
  const canSave = changed.length > 0 && !busy && usernameCheck.state !== "bad" && usernameCheck.state !== "checking";

  const set = (k: Field) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setStatus(null);
    setForm((f) => ({ ...f, [k]: k === "username" ? e.target.value.replace(/\s/g, "") : e.target.value }));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const body = Object.fromEntries(
        changed.map((k) => [k, k === "username" ? form[k].trim().replace(/^@/, "") : form[k].trim()])
      );
      setUser(await usersApi.updateMe(body));
      setStatus("Профиль сохранён");
    } catch (err) {
      setError(apiErrorText(err, "Не удалось сохранить профиль"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={s.form} onSubmit={(e) => void save(e)}>
      <label className={s.field}>
        <span className={s.label}>Никнейм</span>
        <span className={s.nick}>
          <span className={s.at}>@</span>
          <input
            className={`${base.input} ${s.nickInput}`}
            value={form.username}
            onChange={set("username")}
            maxLength={USERNAME_MAX + 1}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="username"
          />
        </span>
        <span
          className={usernameCheck.state === "bad" ? s.bad : usernameCheck.state === "ok" ? s.ok : base.hint}
        >
          {usernameCheck.state === "bad"
            ? usernameCheck.message
            : usernameCheck.state === "ok"
              ? "Никнейм свободен"
              : usernameCheck.state === "checking"
                ? "Проверяем…"
                : "Латиницей. По нему вас находят и @упоминают"}
        </span>
      </label>

      <div className={s.pair}>
        <label className={s.field}>
          <span className={s.label}>Имя</span>
          <input
            className={base.input}
            value={form.first_name}
            onChange={set("first_name")}
            maxLength={64}
            autoComplete="given-name"
          />
        </label>
        <label className={s.field}>
          <span className={s.label}>Фамилия</span>
          <input
            className={base.input}
            value={form.last_name}
            onChange={set("last_name")}
            maxLength={64}
            autoComplete="family-name"
          />
        </label>
      </div>

      <label className={s.field}>
        <span className={s.label}>Электронная почта</span>
        <input
          className={base.input}
          type="email"
          value={form.email}
          onChange={set("email")}
          maxLength={254}
          placeholder="Не указана"
          autoComplete="email"
        />
        <span className={base.hint}>Видна только вам.</span>
      </label>

      <div className={base.rowBtns}>
        <button type="submit" className={base.primary} disabled={!canSave}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
        {changed.length > 0 && (
          <button
            type="button"
            className={base.secondary}
            disabled={busy}
            onClick={() => {
              setForm(initial(user));
              setError(null);
            }}
          >
            Отменить
          </button>
        )}
      </div>
      {status && <div className={base.statusOk}>{status}</div>}
      {error && <div className={base.statusErr}>{error}</div>}
    </form>
  );
}
