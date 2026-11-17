/** Длина кода от Quazar_Admin_bot. */
export const CODE_LENGTH = 5;

/** Оставить из ввода только цифры (вставка «12 345», «12-345»), не больше пяти. */
export function normalizeCode(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, CODE_LENGTH);
}

/** Сколько целых секунд до момента iso; прошло — 0. */
export function secondsUntil(iso: string, now = Date.now()): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}
