import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../../store/auth";
import { useCallStore } from "../../store/call";
import { useTourStore } from "../../tour/store";
import { MAIN_TOUR } from "../../tour/tours";
import TourOverlay from "./TourOverlay";
import s from "./Tour.module.css";

/** Новый аккаунт — обучение начинается само; остальным его только предлагают. */
const NEW_ACCOUNT_MS = 3 * 24 * 3600_000;
const CALM_CHECK_MS = 1500;
const LATER_NOTICE_MS = 4500;

/** На экране нет окон (восстановление ключей, подтверждение телефона…), нет вопроса
 * про уведомления (одно предложение за раз) и нет звонка. */
function screenIsCalm(): boolean {
  const phase = useCallStore.getState().phase;
  if (phase !== "idle" && phase !== "ended") return false;
  return !document.querySelector('[role="dialog"], [aria-modal="true"], [data-notify-prompt]');
}

export function isNewAccount(createdAt: string | undefined, now = Date.now()): boolean {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(at) && now - at < NEW_ACCOUNT_MS;
}

/** Обучение по главному экрану: загрузить прогресс, предложить (или начать), показать шаги. */
export default function TourHost() {
  const user = useAuthStore((st) => st.user);
  const progress = useTourStore((st) => st.progress);
  const active = useTourStore((st) => st.active);
  const finished = useTourStore((st) => st.finished);
  const [calm, setCalm] = useState(false);
  // «Не сейчас» — на месте карточки ненадолго остаётся подсказка, где искать обучение.
  const [later, setLater] = useState(false);
  const autoStarted = useRef(false);

  useEffect(() => {
    useTourStore.getState().reset();
    setCalm(false);
    autoStarted.current = false;
    if (user?.id) void useTourStore.getState().load();
  }, [user?.id]);

  const pending = !!user && !!progress && !progress.main && !active && !finished;

  // Ждём, пока экран освободится: два спокойных замера подряд.
  useEffect(() => {
    if (!pending || calm) return;
    let quiet = 0;
    const timer = setInterval(() => {
      quiet = screenIsCalm() ? quiet + 1 : 0;
      if (quiet >= 2) setCalm(true);
    }, CALM_CHECK_MS);
    return () => clearInterval(timer);
  }, [pending, calm]);

  useEffect(() => {
    if (!later) return;
    const timer = setTimeout(() => setLater(false), LATER_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [later]);

  const fresh = isNewAccount(user?.created_at);
  useEffect(() => {
    if (pending && calm && fresh && !autoStarted.current) {
      autoStarted.current = true;
      useTourStore.getState().start("main");
    }
  }, [pending, calm, fresh]);

  return (
    <>
      <TourOverlay />
      {pending && calm && !fresh && (
        <section className={s.invite} aria-label="Обучение">
          <h3 className={s.title}>Показать, где что находится?</h3>
          <p className={s.text}>{MAIN_TOUR.description} Это займёт минуту.</p>
          <div className={s.actions}>
            <button type="button" className={s.skip} onClick={() => { setLater(true); useTourStore.getState().dismiss("main"); }}>
              Не сейчас
            </button>
            <button type="button" className={s.ok} onClick={() => useTourStore.getState().start("main")}>
              Показать
            </button>
          </div>
        </section>
      )}
      {later && (
        <section className={s.invite} role="status" aria-label="Обучение">
          <p className={s.text}>
            <b className={s.laterTitle}>Ок!</b> Обучающие материалы всегда сможете найти в настройках.
          </p>
        </section>
      )}
    </>
  );
}
