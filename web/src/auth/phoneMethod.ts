/**
 * Как сервер подтвердит номер: звонком или кодом в Telegram. Номера +7 — всегда звонком;
 * остальные — кодом в Telegram, а пока на сервере не настроен Telegram Gateway — тоже звонком
 * (GET /auth/providers → telegram_codes). После старта проверки решает её method.
 */
import { useEffect, useState } from "react";
import { authApi } from "../api/auth";
import { isForeignPhone } from "../utils/phone";

let cached: Promise<boolean> | null = null;

/** Включены ли коды в Telegram. Ошибка запроса — считаем включёнными и спросим снова. */
export function telegramCodes(): Promise<boolean> {
  cached ??= authApi.providers()
    .then(result => result.telegram_codes !== false)
    .catch(() => { cached = null; return true; });
  return cached;
}

export function usePhoneMethod(phone: string): "call" | "telegram" {
  const [codes, setCodes] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void telegramCodes().then(value => { if (active) setCodes(value); });
    return () => { active = false; };
  }, []);
  return isForeignPhone(phone) && codes !== false ? "telegram" : "call";
}
