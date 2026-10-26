import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuthStore } from "../store/auth";
import StatusPicker from "./StatusPicker";
import CustomStatusEditor from "./status/CustomStatusEditor";
import CustomStatusBadge from "./status/CustomStatusBadge";
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
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

  // Меню — в портале на уровне страницы: панели справа стеклянные (backdrop-filter), у каждой
  // свой слой, и меню внутри навигации оказывалось под ними. Ставим его рядом с аватаркой.
  useLayoutEffect(() => {
    if (!statusOpen) return;
    const place = () => {
      const r = profileRef.current?.getBoundingClientRect();
      if (r) setAnchor({ left: r.right + 12, bottom: Math.max(8, window.innerHeight - r.bottom) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [statusOpen]);

  // Клик мимо или Esc — закрыть выбор статуса.
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!profileRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setStatusOpen(false);
      }
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
              title="Статус: свой, на встрече, не беспокоить"
            >
              <UserAvatar username={user.username} avatarUrl={user.avatar_url} size="sm" userId={user.id} />
              <span className={s.profileName}>
                <CustomStatusBadge userId={user.id} compact /> {user.username}
              </span>
            </button>
            {statusOpen &&
              anchor &&
              createPortal(
                <div
                  ref={popoverRef}
                  className={s.statusPopover}
                  style={{ left: anchor.left, bottom: anchor.bottom }}
                  role="dialog"
                  aria-label="Статус"
                >
                  <div className={s.statusTitle}>Свой статус</div>
                  <CustomStatusEditor onDone={() => setStatusOpen(false)} />
                  <div className={s.statusTitle} style={{ marginTop: 16 }}>
                    На встрече или не беспокоить
                  </div>
                  <StatusPicker onDone={() => setStatusOpen(false)} />
                </div>,
                document.body
              )}
          </div>
        )}
      </aside>
      {!hideBottomNav && <nav className={s.bottom}>{renderItems("bottom")}</nav>}
    </>
  );
}
