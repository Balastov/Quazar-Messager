import { useState } from "react";
import { createPortal } from "react-dom";
import { adminApi, type AdminUser } from "../../api/admin";
import Dialog from "../constellation/Dialog";
import { apiError } from "../constellation/rules";
import { premiumDate } from "../premium/premiumText";
import s from "./BlackHole.module.css";

export function premiumLabel(u: AdminUser): string {
  if (!u.premium_kind) return "";
  if (u.premium_kind === "superuser") return "Premium бессрочно";
  const kind = u.premium_kind === "trial" ? "пробный" : u.premium_kind === "purchase" ? "куплен" : "выдан";
  return u.premium_until ? `Premium ${kind} до ${premiumDate(u.premium_until)}` : `Premium ${kind}, бессрочно`;
}

const OPTIONS: [number | null, string][] = [[1, "1 месяц"], [3, "3 месяца"], [12, "12 месяцев"], [null, "Бессрочно"]];

/** Выдать или снять Quazar Premium — подарок или проверка. */
export default function PremiumGrantDialog({ user, onClose, onDone }: { user: AdminUser; onClose(): void; onDone(next: AdminUser): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<AdminUser>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(apiError(err));
      setBusy(false);
    }
  };
  return createPortal(
    <Dialog title={`Quazar Premium · @${user.username}`} onClose={onClose}>
      <p className={s.hint}>
        {user.premium_kind ? `Сейчас: ${premiumLabel(user)}.` : "Сейчас Premium нет."} Новый срок
        отсчитывается от конца действующего Premium; пробный месяц при этом заканчивается.
      </p>
      <div className={s.actions}>
        {OPTIONS.map(([months, label]) => (
          <button key={label} type="button" className={s.btn} disabled={busy} onClick={() => void run(() => adminApi.grantPremium(user.id, months))}>
            {label}
          </button>
        ))}
      </div>
      {user.premium_kind && (
        <div className={s.actions}>
          <button
            type="button"
            className={`${s.btn} ${s.btnDanger}`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Снять Quazar Premium с @${user.username}? Его Звёзды останутся, но новых сверх 2 не создать.`)) {
                void run(() => adminApi.revokePremium(user.id));
              }
            }}
          >
            Снять Premium
          </button>
        </div>
      )}
      {error && <div className={s.error}>{error}</div>}
    </Dialog>,
    document.body
  );
}
