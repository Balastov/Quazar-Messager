import { useEffect, useState } from "react";
import { premiumApi, type PremiumInfo } from "../../api/premium";
import { usersApi } from "../../api/users";
import { useAuthStore } from "../../store/auth";
import { useUiStore } from "../../store/ui";
import { apiError } from "../constellation/rules";
import BuyPremiumDialog from "./BuyPremiumDialog";
import PremiumBadge from "./PremiumBadge";
import s from "./Premium.module.css";
import base from "../SettingsView.module.css";

/** Упёрлись в лимит Звёзд: что даст Premium и пробный месяц в одно нажатие. */
export default function PremiumUpsell({ onUpgraded, onOpenSettings }: { onUpgraded(): void; onOpenSettings?(): void }) {
  const [info, setInfo] = useState<PremiumInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    premiumApi.get().then(setInfo).catch(() => {});
  }, []);
  if (!info || info.forever) return null;
  const { free, trial, premium } = info.star_limits;

  const startTrial = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await premiumApi.startTrial());
      useAuthStore.getState().setUser(await usersApi.me());
      onUpgraded();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.upsell}>
      <div className={s.upsellTitle}>
        <PremiumBadge size={16} /> Quazar Premium
      </div>
      <p className={base.hint}>
        {info.kind === "trial"
          ? `В пробном месяце — до ${trial} своих Звёзд, с Premium — до ${premium}.`
          : `Без Premium — до ${free} своих Звёзд, с Premium — до ${premium}, в пробном месяце — до ${trial}.`}
      </p>
      {error && <p className={base.statusErr}>{error}</p>}
      <div className={base.rowBtns}>
        {info.trial_available && (
          <button type="button" className={base.primary} disabled={busy} onClick={() => void startTrial()}>
            Попробовать бесплатно — 1 месяц
          </button>
        )}
        <button type="button" className={base.secondary} onClick={() => setBuying(true)}>
          Купить
        </button>
        <button
          type="button"
          className={base.secondary}
          onClick={() => {
            onOpenSettings?.();
            useUiStore.getState().openSettings("premium");
          }}
        >
          Подробнее
        </button>
      </div>
      {!info.trial_available && info.trial_unavailable_reason && <p className={base.hint}>{info.trial_unavailable_reason}</p>}
      {buying && <BuyPremiumDialog trialAvailable={info.trial_available} onTrial={() => void startTrial()} onClose={() => setBuying(false)} />}
    </div>
  );
}
