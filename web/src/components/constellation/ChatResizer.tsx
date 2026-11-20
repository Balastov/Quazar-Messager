import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { CHAT_MIN, KEY_STEP, clampChatWidth, maxChatWidth } from "./roomChatWidth";
import w from "./Work.module.css";

interface Props {
  /** Раскладка «комната + чат»: от её ширины зависит, насколько чат можно расширить. */
  layout: RefObject<HTMLElement | null>;
  /** Сам чат: его текущая ширина — точка отсчёта. */
  panel: RefObject<HTMLElement | null>;
  width: number | null;
  onChange: (width: number) => void;
  /** Отпустили или нажали клавишу — запомнить. */
  onCommit: (width: number) => void;
  onReset: () => void;
}

/** Левый край чата комнаты: тянуть мышью, стрелками с клавиатуры; двойной щелчок — ширина по умолчанию. */
export default function ChatResizer({ layout, panel, width, onChange, onCommit, onReset }: Props) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const layoutWidth = () => layout.current?.getBoundingClientRect().width ?? window.innerWidth;
  const current = () => width ?? panel.current?.getBoundingClientRect().width ?? CHAT_MIN;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = current();
    drag.current = { x: e.clientX, width: start, last: start };
    document.body.classList.add(w.resizingCol);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Край слева: тянем влево — чат шире.
    d.last = clampChatWidth(d.width + d.x - e.clientX, layoutWidth());
    onChange(d.last);
  };
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove(w.resizingCol);
    if (d.last !== d.width) onCommit(d.last);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: KEY_STEP, ArrowRight: -KEY_STEP }[e.key];
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      onCommit(e.key === "Home" ? CHAT_MIN : maxChatWidth(layoutWidth()));
    } else if (step) {
      e.preventDefault();
      onCommit(clampChatWidth(current() + step, layoutWidth()));
    }
  };

  const now = Math.round(current());
  return (
    <div
      className={w.chatResizer}
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина чата"
      aria-valuemin={CHAT_MIN}
      aria-valuemax={maxChatWidth(layoutWidth())}
      aria-valuenow={now}
      tabIndex={0}
      title="Потяните, чтобы изменить ширину чата. Двойной щелчок — как было"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
