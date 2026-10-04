import { useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { getNotifyPrefs, setNotifyPrefs } from "../notifications/prefs";
import UserAvatar from "./UserAvatar";
import { IconChat, IconMore, IconPhone, IconVideo } from "./icons";
import s from "./PeerPanel.module.css";

export default function PeerPanel() {
  const activeChatId = useChatStore((st) => st.activeChatId);
  const chats = useChatStore((st) => st.chats);
  const setShowE2ePanel = useChatStore((st) => st.setShowE2ePanel);
  const currentUser = useAuthStore((st) => st.user);
  const [notifyOn, setNotifyOn] = useState(() => getNotifyPrefs().enabled);
  const [mediaTab, setMediaTab] = useState<"media" | "files" | "links">("media");

  const chat = chats.find((c) => c.id === activeChatId);
  if (!chat || !activeChatId) {
    return (
      <aside className={s.root}>
        <p className={s.mediaEmpty}>Выберите чат, чтобы увидеть профиль собеседника</p>
      </aside>
    );
  }

  const peer =
    chat.type === "group"
      ? { username: chat.name ?? "Группа", avatar_url: null as string | null }
      : (() => {
          const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
          return {
            username: other?.username ?? "Неизвестный",
            avatar_url: other?.avatar_url ?? null,
          };
        })();

  return (
    <aside className={s.root}>
      <div className={s.profile}>
        <UserAvatar username={peer.username} avatarUrl={peer.avatar_url} size="lg" />
        <div className={s.name}>{peer.username}</div>
        <div className={s.status}>В Quazar</div>
      </div>

      <div className={s.actions}>
        <button type="button" className={`${s.action} ${s.actionPrimary}`}>
          <IconChat size={18} />
          Чат
        </button>
        <button type="button" className={s.action} title="Скоро">
          <IconPhone size={18} />
          Звонок
        </button>
        <button type="button" className={s.action} title="Скоро">
          <IconVideo size={18} />
          Видео
        </button>
        <button type="button" className={s.action} onClick={() => setShowE2ePanel(true)}>
          <IconMore size={18} />
          Ещё
        </button>
      </div>

      <section className={s.section}>
        <div className={s.sectionTitle}>О себе</div>
        <p className={s.about}>Пользователь Quazar Messager</p>
      </section>

      <div className={s.row}>
        <span>Уведомления</span>
        <label className={s.toggle}>
          <input
            type="checkbox"
            checked={notifyOn}
            onChange={(e) => {
              setNotifyOn(e.target.checked);
              setNotifyPrefs({ enabled: e.target.checked });
            }}
          />
          <span className={s.toggleUi} />
        </label>
      </div>

      <section className={s.section}>
        <div className={s.mediaTabs}>
          {(
            [
              ["media", "Медиа"],
              ["files", "Файлы"],
              ["links", "Ссылки"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={mediaTab === id ? s.tabActive : s.tab}
              onClick={() => setMediaTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={s.mediaEmpty}>
          Общие вложения появятся здесь.
          <span className={s.soon}> Скоро.</span>
        </p>
      </section>
    </aside>
  );
}
