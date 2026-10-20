import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth";
import StatusPicker from "./StatusPicker";
import { useChatStore } from "../store/chat";
import { useStarsStore } from "../store/stars";
import { useUiStore, type AppTab } from "../store/ui";
import UserAvatar from "./UserAvatar";
import {
  IconCalls,
  IconChat,
  IconConstellation,
  IconContacts,
  IconSettings,
} from "./icons";
import s from "./AppNav.module.css";

const ITEMS: { id: AppTab; label: string; Icon: typeof IconChat }[] = [
  { id: "contacts", label: "Контакты", Icon: IconContacts },
  { id: "chats", label: "Чат", Icon: IconChat },
  { id: "stars", label: "Созвездие", Icon: IconConstellation },
  { id: "calls", label: "Звонки", Icon: IconCalls },
  { id: "settings", label: "Настройки", Icon: IconSettings },
];

export default function AppNav() {
  const tab = useUiStore((st) => st.tab);
  const setTab = useUiStore((st) => st.setTab);
  const mobileChatOpen = useUiStore((st) => st.mobileChatOpen);
  const activeChatId = useChatStore((st) => st.activeChatId);
  const starChannelOpen = useStarsStore((st) => st.mobileChannelOpen);
  const hideBottomNav =
    (mobileChatOpen && !!activeChatId) || (tab === "stars" && starChannelOpen);
  const user = useAuthStore((st) => st.user);
  const [statusOpen, setStatusOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  // Клик мимо или Esc — закрыть выбор статуса.
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setStatusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setStatusOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [statusOpen]);

  const renderItems = (variant: "side" | "bottom") =>
    ITEMS.map(({ id, label, Icon }) => {
      const active = tab === id;
      const cls =
        variant === "side"
          ? active
            ? s.itemActive
            : s.item
          : active
            ? s.bottomItemActive
            : s.bottomItem;
      return (
        <button key={id} type="button" className={cls} onClick={() => setTab(id)}>
          <Icon size={variant === "side" ? 22 : 20} />
          <span>{label}</span>
        </button>
      );
    });

  return (
    <>
      <aside className={s.side}>
        <img className={s.logo} src="/logo-mark.png" alt="Quazar" />
        <nav className={s.navItems}>{renderItems("side")}</nav>
        {user && (
          <div className={s.profile} ref={profileRef}>
            <button
              type="button"
              className={s.profileBtn}
              onClick={() => setStatusOpen((open) => !open)}
              aria-expanded={statusOpen}
              title="Статус: на встрече, не беспокоить"
            >
              <UserAvatar username={user.username} avatarUrl={user.avatar_url} size="sm" userId={user.id} />
              <span className={s.profileName}>{user.username}</span>
            </button>
            {statusOpen && (
              <div className={s.statusPopover} role="dialog" aria-label="Статус">
                <div className={s.statusTitle}>Статус</div>
                <StatusPicker onDone={() => setStatusOpen(false)} />
              </div>
            )}
          </div>
        )}
      </aside>
      {!hideBottomNav && <nav className={s.bottom}>{renderItems("bottom")}</nav>}
    </>
  );
}
