import { http } from "./client";
import type { PremiumState } from "./types";

export interface PremiumInfo extends PremiumState {
  trial_available: boolean;
  /** Почему пробный месяц недоступен — показываем как есть. */
  trial_unavailable_reason: string | null;
  trial_days: number;
  /** Своё ограничение Звёзд; null — без ограничения. */
  star_limit: number | null;
  owned_stars: number;
  star_limits: { free: number; trial: number; premium: number };
}

export const premiumApi = {
  get: () => http.get<PremiumInfo>("/premium").then((r) => r.data),
  startTrial: () => http.post<PremiumInfo>("/premium/trial").then((r) => r.data),
};
