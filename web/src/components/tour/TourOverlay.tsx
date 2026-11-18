import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTourStore } from "../../tour/store";
import { REPLAY_PLACE, stepApplies, stepPosition, tourAvailable, tourById } from "../../tour/tours";
import { usePhoneLayout } from "../../navigation/usePhoneLayout";
import { findTarget, placeCard, spotlight, type Box, type Insets } from "../../tour/geometry";
import s from "./Tour.module.css";

/** Сколько ждать, пока элемент шага появится (экран переключается), прежде чем пропустить шаг. */
const WAIT_TARGET_MS = 1500;

function safeInsets(): Insets {
  const css = getComputedStyle(document.documentElement);
  const px = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
  return { top: px("--qz-safe-top"), right: px("--qz-safe-right"), bottom: px("--qz-safe-bottom"), left: px("--qz-safe-left") };
}

function sameBox(a: Box | null, b: Box | null) {
  return !!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * Обучение поверх приложения: зелёная рамка вокруг элемента, рядом — пояснение и «Понятно».
 * В портале на body: стеклянные панели держат свои слои, внутри них рамка оказалась бы под ними.
 */
export default function TourOverlay() {
  const active = useTourStore((st) => st.active);
  const finished = useTourStore((st) => st.finished);
  const next = useTourStore((st) => st.next);
  const skip = useTourStore((st) => st.skip);
  const closeFinished = useTourStore((st) => st.closeFinished);
  const progress = useTourStore((st) => st.progress);
  const start = useTourStore((st) => st.start);
  const tour = active ? tourById(active.id) : undefined;
  const step = tour && active ? tour.steps[active.index] : undefined;
  const phone = usePhoneLayout();
  const [target, setTarget] = useState<Box | null>(null);
  const [card, setCard] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  // Шаг: открыть нужный экран, дождаться элемента и следить за ним (прокрутка, поворот, анимации).
  useEffect(() => {
    if (!step) return;
    setTarget(null);
    setCard(null);
    // Шаг для другой раскладки (например, «Контакты» есть только на телефоне) — сразу дальше.
    if (!stepApplies(step, phone) || (step.when && !step.when())) {
      next();
      return;
    }
    step.prepare?.();
    const started = performance.now();
    const patience = step.wait ?? WAIT_TARGET_MS;
    let frame = 0;
    let scrolled = false;
    let last: Box | null = null;
    const tick = () => {
      const el = findTarget(step.target);
      if (!el) {
        if (performance.now() - started > patience) {
          next(); // Этого элемента на таком экране нет (например, только на компьютере).
          return;
        }
      } else {
        if (!scrolled) {
          el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          scrolled = true;
        }
        const r = el.getBoundingClientRect();
        const box = spotlight({ top: r.top, left: r.left, width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight });
        if (!sameBox(box, last)) {
          last = box;
          setTarget(box);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [step, next, phone]);

  // Подсказка — рядом с рамкой, где хватает места.
  useLayoutEffect(() => {
    if (!target || !cardRef.current) return;
    const { offsetWidth: width, offsetHeight: height } = cardRef.current;
    const place = placeCard(target, { width, height }, { width: window.innerWidth, height: window.innerHeight }, safeInsets());
    setCard((prev) => (prev && prev.top === place.top && prev.left === place.left ? prev : { top: place.top, left: place.left }));
  }, [target, step]);

  useEffect(() => {
    if (card) okRef.current?.focus({ preventScroll: true });
  }, [card, step]);

  useEffect(() => {
    if (!step && !finished) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (step) skip();
        else closeFinished();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, finished, skip, closeFinished]);

  if (finished) {
    const done = tourById(finished);
    // Следующее по теме обучение (например, после «Внутри Звезды» — про рабочую Звезду).
    const nextId = done?.next?.() ?? null;
    const following = nextId ? tourById(nextId) : undefined;
    const offerNext = !!following && tourAvailable(following) && progress?.[following.id]?.state !== "done";
    return createPortal(
      <div className={s.layer}>
        <div className={s.dim} />
        <div className={s.congrats} role="dialog" aria-modal="true" aria-labelledby="tour-congrats-title">
          <div className={s.congratsIcon} aria-hidden>🎉</div>
          <h3 id="tour-congrats-title" className={s.title}>Поздравляем!</h3>
          <p className={s.text}>
            Вы теперь знаете {done?.subject ?? "Quazar"}. Повторно эту информацию можно просмотреть в {REPLAY_PLACE}.
          </p>
          {offerNext && following ? (
            <div className={s.congratsActions}>
              <button type="button" className={s.ok} onClick={() => start(following.id)} autoFocus>
                Дальше: {following.title}
              </button>
              <button type="button" className={s.skip} onClick={closeFinished}>
                Хватит на сегодня
              </button>
            </div>
          ) : (
            <button type="button" className={s.ok} onClick={closeFinished} autoFocus>
              Отлично
            </button>
          )}
        </div>
      </div>,
      document.body
    );
  }

  if (!tour || !step || !active || !stepApplies(step, phone)) return null;
  const position = stepPosition(tour, active.index, phone);
  return createPortal(
    <div className={s.layer}>
      {/* Клики мимо подсказки не уходят в приложение: обучение ведёт по шагам. */}
      <div className={target ? s.blocker : s.dim} />
      {target && (
        <div className={s.spotlight} style={{ top: target.top, left: target.left, width: target.width, height: target.height }} aria-hidden />
      )}
      <div
        ref={cardRef}
        className={s.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        style={card ? { top: card.top, left: card.left } : { visibility: "hidden" }}
      >
        <div className={s.counter}>
          {position.n} из {position.total}
        </div>
        <h3 id="tour-step-title" className={s.title}>{step.title}</h3>
        <p className={s.text}>{(phone && step.phoneText) || step.text}</p>
        <div className={s.actions}>
          <button type="button" className={s.skip} onClick={skip}>
            Пропустить обучение
          </button>
          <button ref={okRef} type="button" className={s.ok} onClick={next}>
            Понятно
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
