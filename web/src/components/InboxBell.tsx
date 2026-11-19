import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell } from "lucide-react";
import type { InboxItem } from "../api/inbox";
import { formatWhen } from "../chat/when";
import { useInboxStore } from "../store/inbox";
import s from "./InboxBell.module.css";

const ICON: Record<string, string> = {
  booking_invite: "📅",
  booking_cancelled: "🚫",
  booking_soon: "⏰",
  booking_started: "▶️",
};

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  return formatWhen(iso, new Date(now));
}

/**
 * Зелёный колокольчик: приглашения на встречи и их изменения, которые не теряются.
 * side — в левом меню на компьютере, floating — круглая кнопка справа в шапке главных экранов на телефоне.
 */
export default function InboxBell({ variant }: { variant: "side" | "floating" }) {
  const unread = useInboxStore((st) => st.unread);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<React.CSSProperties | null>(null);

  // Панель — в портале: стеклянные панели (backdrop-filter) создают свои слои и закрыли бы её.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setPlace(
        variant === "side"
          ? { left: r.right + 12, top: Math.max(8, r.top) }
          : { right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 8 }
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, variant]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = unread ? `Уведомления, непрочитанных: ${unread}` : "Уведомления";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={variant === "side" ? s.side : s.floating}
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        title={label}
      >
        <Bell size={variant === "side" ? 20 : 18} />
        {unread > 0 && <span className={s.count} aria-hidden>{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && place && createPortal(
        <div ref={panelRef} className={`${s.panel} ${variant === "floating" ? s.panelFloating : ""}`} style={place} role="dialog" aria-label="Уведомления">
          <InboxPanel onDone={() => setOpen(false)} />
        </div>,
        document.body
      )}
    </>
  );
}

function InboxPanel({ onDone }: { onDone: () => void }) {
  const items = useInboxStore((st) => st.items);
  const unread = useInboxStore((st) => st.unread);
  const loaded = useInboxStore((st) => st.loaded);
  const hasMore = useInboxStore((st) => st.hasMore);
  const { load, loadMore, open, markAllRead } = useInboxStore.getState();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load().catch(() => setError("Не удалось загрузить уведомления"));
  }, [loaded, load]);

  const choose = (item: InboxItem) => {
    onDone();
    void open(item);
  };

  return (
    <>
      <div className={s.head}>
        <span className={s.title}>Уведомления</span>
        {unread > 0 && (
          <button type="button" className={s.readAll} onClick={() => void markAllRead().catch(() => {})}>
            Прочитать все
          </button>
        )}
      </div>
      {error && <div className={s.empty}>{error}</div>}
      {!error && loaded && items.length === 0 && (
        <div className={s.empty}>Здесь появятся приглашения на встречи, их отмены и напоминания.</div>
      )}
      {!loaded && !error && <div className={s.empty}>Загрузка…</div>}
      <ul className={s.list}>
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className={item.read_at ? s.item : `${s.item} ${s.unread}`} onClick={() => choose(item)}>
              <span className={s.icon} aria-hidden>{ICON[item.kind] ?? "🔔"}</span>
              <span className={s.text}>
                <span className={s.itemTitle}>{item.title}</span>
                {item.body && <span className={s.itemBody}>{item.body}</span>}
                <span className={s.time}>{ago(item.created_at)}</span>
              </span>
              {!item.read_at && <span className={s.dot} aria-label="Не прочитано" />}
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" className={s.more} onClick={() => void loadMore().catch(() => {})}>
          Показать ещё
        </button>
      )}
    </>
  );
}
