import { useCallback, useEffect, useState } from "react";
import { premiumApi, type PremiumInfo } from "../../api/premium";
import { usersApi } from "../../api/users";
import { useAuthStore } from "../../store/auth";
import BuyPremiumDialog from "../premium/BuyPremiumDialog";
import PremiumBadge from "../premium/PremiumBadge";
import PremiumStatus from "../premium/PremiumStatus";
import p from "../premium/Premium.module.css";
import { useSettingsRun } from "./useSettingsRun";
import s from "../SettingsView.module.css";

type Column = "free" | "trial" | "premium";

/** Quazar Premium: состояние, что даёт, пробный месяц и (пока недоступная) покупка. */
export default function PremiumSection() {
  const [info, setInfo] = useState<PremiumInfo | null>(null);
  const [buying, setBuying] = useState(false);
  const { busy, run, setStatus, setError, feedback } = useSettingsRun();

  const load = useCallback(() => {
    premiumApi.get().then(setInfo).catch(() => setError("Не удалось загрузить Quazar Premium"));
  }, [setError]);
  useEffect(load, [load]);

  const startTrial = () =>
    void run(async () => {
      setInfo(await premiumApi.startTrial());
      // Значок у имени и подпись в профиле — сразу.
      useAuthStore.getState().setUser(await usersApi.me());
      setStatus("Пробный Quazar Premium подключён");
    });

  if (!info) return <>{feedback}</>;
  const column: Column = !info.active ? "free" : info.kind === "trial" ? "trial" : "premium";
  const limits = info.star_limits;
  const cell = (id: Column, value: string) => <td className={column === id ? p.mine : undefined}>{value}</td>;

  return (
    <>
      <section className={s.card}>
        <div className={p.hero}>
          <span className={p.heroStar}>
            <PremiumBadge size={30} />
          </span>
          <div>
            <div className={p.heroTitle}>Quazar Premium</div>
            <p className={p.status}>
              <PremiumStatus state={info} />
            </p>
          </div>
        </div>
        <div className={s.rowBtns}>
          {info.trial_available && (
            <button type="button" className={s.primary} disabled={busy} onClick={startTrial}>
              Попробовать бесплатно — {info.trial_days === 30 ? "1 месяц" : `${info.trial_days} дней`}
            </button>
          )}
          {!info.forever && (
            <button type="button" className={info.trial_available ? s.secondary : s.primary} onClick={() => setBuying(true)}>
              Купить
            </button>
          )}
        </div>
        {!info.trial_available && info.trial_unavailable_reason && !info.active && (
          <p className={s.hint}>{info.trial_unavailable_reason}</p>
        )}
      </section>

      <section className={s.card}>
        <h3 className={s.sectionTitle}>Что даёт Premium</h3>
        <table className={p.compare}>
          <thead>
            <tr>
              <th />
              <th>Бесплатно</th>
              <th>Пробный</th>
              <th>Premium</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Своих Звёзд</td>
              {cell("free", String(limits.free))}
              {cell("trial", String(limits.trial))}
              {cell("premium", String(limits.premium))}
            </tr>
            <tr>
              <td>Значок у имени</td>
              {cell("free", "—")}
              {cell("trial", "есть")}
              {cell("premium", "есть")}
            </tr>
          </tbody>
        </table>
        <p className={s.hint}>
          {info.star_limit === null
            ? `Своих Звёзд: ${info.owned_stars}, без ограничения.`
            : `Своих Звёзд сейчас: ${info.owned_stars} из ${info.star_limit}.`}{" "}
          Значок Premium — зелёную звезду рядом с вашим именем — видят все.
        </p>
        <p className={s.hint}>
          Когда Premium закончится, все ваши Звёзды останутся и продолжат работать — просто новую
          не создать, пока своих больше {limits.free}. О конце пробного месяца напомнит
          Quazar_news_bot за 3 дня и в последний день.
        </p>
      </section>
      {feedback}
      {buying && (
        <BuyPremiumDialog trialAvailable={info.trial_available} onTrial={startTrial} onClose={() => setBuying(false)} />
      )}
    </>
  );
}
