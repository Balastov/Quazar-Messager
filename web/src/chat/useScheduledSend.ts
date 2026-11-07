import { useEffect, useRef, type ButtonHTMLAttributes } from "react";

/** A tap submits normally; a hold opens scheduling and consumes the release click. */
export function useScheduledSend(open: () => void, scope?: string | null): ButtonHTMLAttributes<HTMLButtonElement> {
  const callback = useRef(open); callback.current = open;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const cancel = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; start.current = null; };
  useEffect(() => () => {
    if (start.current) suppressClick.current = true;
    cancel();
  }, [scope]);
  return {
    title: "Отправить · удерживайте для отправки позже",
    "aria-description": "Для отправки позже удерживайте кнопку, нажмите правой кнопкой мыши или Shift+F10",
    "aria-keyshortcuts": "Shift+F10",
    onPointerDown: event => {
      if (event.currentTarget.disabled) return;
      cancel(); suppressClick.current = false;
      if (event.button !== 0) return;
      start.current = { x: event.clientX, y: event.clientY };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic or unsupported pointer. */ }
      timer.current = setTimeout(() => {
        if (!start.current) return;
        timer.current = null; suppressClick.current = true;
        callback.current();
      }, 450);
    },
    onPointerMove: event => {
      const at = start.current;
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 10) { cancel(); suppressClick.current = true; }
    },
    onPointerUp: event => { cancel(); if (suppressClick.current) event.preventDefault(); },
    // Pointer-up cancellation alone does not suppress the compatibility click on iOS.
    // The touch keeps its original target even when the scheduling overlay appears.
    onTouchEnd: event => { if (suppressClick.current) event.preventDefault(); },
    onPointerCancel: () => { cancel(); suppressClick.current = true; },
    onLostPointerCapture: cancel,
    onContextMenu: event => {
      event.preventDefault(); cancel();
      if (suppressClick.current) return;
      suppressClick.current = true; callback.current();
    },
    onClickCapture: event => {
      if (!suppressClick.current) return;
      event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
    },
    onKeyDown: event => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault(); cancel();
        if (!event.repeat) { suppressClick.current = true; callback.current(); }
      } else if (event.key === "Enter" || event.key === " ") suppressClick.current = false;
    },
  };
}
