import { useEffect, useState } from "react";

/** Телефонная раскладка: нижнее меню вместо бокового (как в AppNav.module.css). */
export const PHONE_QUERY = "(max-width: 767px)";

/** Сейчас — телефонная раскладка (без подписки на изменения). */
export function isPhoneLayout(): boolean {
  return !!window.matchMedia?.(PHONE_QUERY).matches;
}

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => !!window.matchMedia?.(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return phone;
}
