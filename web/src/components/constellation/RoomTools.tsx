import { useEffect, useId, useState, type ReactNode } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import WorkRoomExtras from "./WorkRoom";
import s from "./RoomTools.module.css";

function readCollapsed(key: string): boolean {
  try { return localStorage.getItem(key) === "true"; }
  catch { return false; }
}

/** Сворачивание не размонтирует формы и не прерывает общий таймер. */
export default function RoomTools({ detail, channel, children, summary }: {
  detail: StarDetail; channel: StarChannel; children?: ReactNode; summary?: ReactNode;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const preferenceKey = `quazar-room-tools-collapsed:${myId ?? "anonymous"}`;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(preferenceKey));
  const contentId = useId();
  useEffect(() => { setCollapsed(readCollapsed(preferenceKey)); }, [preferenceKey]);
  const workExtras = detail.kind === "work" && channel.kind === "planet" && channel.room_kind !== "lobby";
  if (!workExtras && !children) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(preferenceKey, String(next)); } catch { /* Настройка работает и без хранилища. */ }
  };
  const title = detail.kind === "work" ? "Инструменты комнаты" : "Инструменты планеты";
  return <section className={s.panel} aria-label={title}>
    <div className={s.header}>
      <strong className={s.title}>{title}</strong>
      {collapsed && summary && <div className={s.summary}>{summary}</div>}
      <button type="button" className={s.toggle} aria-expanded={!collapsed} aria-controls={contentId} onClick={toggle}>
        {collapsed ? "Развернуть" : "Свернуть"}<span aria-hidden>{collapsed ? "⌄" : "⌃"}</span>
      </button>
    </div>
    <div id={contentId} className={s.body} hidden={collapsed}>
      <WorkRoomExtras detail={detail} channel={channel} />
      {children}
    </div>
  </section>;
}
