import { useAuthStore } from "../store/auth";
import { useUiStore, type AppTab } from "../store/ui";
import UserAvatar from "./UserAvatar";
import {
  IconCalls,
  IconChat,
  IconContacts,
  IconSettings,
} from "./icons";
import s from "./AppNav.module.css";

const ITEMS: { id: AppTab; label: string; Icon: typeof IconChat }[] = [
  { id: "contacts", label: "Контакты", Icon: IconContacts },
  { id: "chats", label: "Чат", Icon: IconChat },
  { id: "calls", label: "Звонки", Icon: IconCalls },
  { id: "settings", label: "Настройки", Icon: IconSettings },
];

export default function AppNav() {
  const tab = useUiStore((st) => st.tab);
  const setTab = useUiStore((st) => st.setTab);
  const mobileChatOpen = useUiStore((st) => st.mobileChatOpen);
  const user = useAuthStore((st) => st.user);

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
          <div className={s.profile}>
            <UserAvatar username={user.username} avatarUrl={user.avatar_url} size="sm" />
            <span className={s.profileName}>{user.username}</span>
          </div>
        )}
      </aside>
      {!mobileChatOpen && <nav className={s.bottom}>{renderItems("bottom")}</nav>}
    </>
  );
}
