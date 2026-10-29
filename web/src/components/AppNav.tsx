import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuthStore } from "../store/auth";
import StatusPicker from "./StatusPicker";
import CustomStatusEditor from "./status/CustomStatusEditor";
import CustomStatusBadge from "./status/CustomStatusBadge";
import { useChatStore } from "../store/chat";
import { useStarsStore } from "../store/stars";
import { useUiStore, type AppTab } from "../store/ui";
import { useAdminStore } from "../store/admin";
import { useUnreadStore } from "../store/unread";
import { chatLevel, useNotifyStore } from "../notifications/levels";
import { MessageSquareHeart, Orbit } from "lucide-react";
import UserAvatar from "./UserAvatar";
import {
  IconCalls,
  IconChat,
  IconConstellation,
  IconContacts,
  IconSettings,
} from "./icons";
import s from "./AppNav.module.css";
import f from "./support/Support.module.css";
import { displayName } from "../utils/profile";
import { version } from "../../package.json";

const ITEMS: { id: AppTab; label: string; Icon: typeof IconChat }[] = [
  { id: "contacts", label: "Контакты", Icon: IconContacts },
  { id: "chats", label: "Чат", Icon: IconChat },
  { id: "stars", label: "Созвездие", Icon: IconConstellation },
  { id: "calls", label: "Звонки", Icon: IconCalls },
  { id: "settings", label: "Настройки", Icon: IconSettings },
];

/** Только владельцам ресурса — последним пунктом. */
const BLACK_HOLE = { id: "blackhole" as AppTab, label: "Чёрная дыра", Icon: Orbit as unknown as typeof IconChat };

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

  const isSuper = useAdminStore((st) => st.isSuper);
  const items = isSuper ? [...ITEMS, BLACK_HOLE] : ITEMS;
  // Всего непрочитанных — на значке «Чат». Чаты с выключенными уведомлениями не считаем.
  const unreadCounts = useUnreadStore((st) => st.counts);
  const notifySettings = useNotifyStore((st) => st.settings);
  const totalUnread = Object.entries(unreadCounts).reduce(
    (sum, [chatId, n]) => (chatLevel(notifySettings, chatId) === "none" ? sum : sum + n),
    0
  );
  const renderItems = (variant: "side" | "bottom") =>
    items.map(({ id, label, Icon }) => {
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
        <button
          key={id}
          type="button"
          className={cls}
          onClick={() => setTab(id)}
          aria-label={id === "chats" && totalUnread ? `${label}, непрочитанных: ${totalUnread}` : undefined}
        >
          <span className={s.iconWrap}>
            <Icon size={variant === "side" ? 22 : 20} />
            {id === "chats" && totalUnread > 0 && (
              <span className={s.unreadBadge} aria-hidden>
                {totalUnread > 99 ? "99+" : totalUnread}
              </span>
            )}
          </span>
          <span>{label}</span>
        </button>
      );
    });

  return (
    <>
      <aside className={s.side}>
        <div className={s.brand}>
          <img className={s.logo} src="/logo-mark.png?v=neon-q-2" alt="Quazar" />
          <span className={s.version} aria-label={`Версия приложения ${version}`}>{version}</span>
        </div>
        <nav className={s.navItems}>{renderItems("side")}</nav>
        <button
          type="button"
          className={f.navButton}
          onClick={() => useUiStore.getState().setFeedbackOpen(true)}
          title="Обратная связь: предложение, вопрос или ошибка"
          aria-label="Обратная связь"
        >
          <MessageSquareHeart size={20} />
        </button>
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
                <CustomStatusBadge userId={user.id} compact /> {displayName(user)}
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
