import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import s from "./RoomActivities.module.css";

/** Полноэкранная доска/видео вместе с управлением разговором. */
export default function ActivityFrame({ title, children, controls }: { title: string; children: ReactNode; controls: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [portalHost] = useState(() => document.createElement("div"));
  const [native, setNative] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const full = native || expanded;
  // Контейнер портала остаётся тем же: разворачивание не размонтирует плеер
  // и не сбрасывает ещё не сохранённый текст/выбранный объект доски.
  useLayoutEffect(() => { (expanded ? document.body : slot.current)?.appendChild(portalHost); }, [expanded, portalHost]);
  useEffect(() => () => portalHost.remove(), [portalHost]);
  useEffect(() => {
    const change = () => setNative(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  const toggle = () => {
    if (expanded) setExpanded(false);
    else if (native) void document.exitFullscreen().catch(() => {});
    else if (ref.current?.requestFullscreen) void ref.current.requestFullscreen().catch(() => setExpanded(true));
    else setExpanded(true);
  };
  const content = (
    <div ref={ref} data-activity-frame className={`${s.frame} ${full ? s.full : ""} ${expanded ? s.expanded : ""}`}
      role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label={expanded ? title : undefined}>
      <div className={s.frameHeader}>
        <strong>{title}</strong>
        <button type="button" className={s.button} onClick={toggle}
          aria-label={full ? "Выйти из полноэкранного режима" : "На весь экран"}>
          {full ? "Свернуть" : "На весь экран"}
        </button>
      </div>
      <div className={s.frameBody}>{children}</div>
      {full && <div className={s.fullControls}>{controls}</div>}
    </div>
  );
  return <><div ref={slot} />{createPortal(content, portalHost)}</>;
}
