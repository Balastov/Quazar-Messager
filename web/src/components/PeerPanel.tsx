import { useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { useCallStore } from "../store/call";
import { getNotifyPrefs, setNotifyPrefs } from "../notifications/prefs";
import UserAvatar from "./UserAvatar";
import { usePresence, usePresenceText } from "../store/presence";
import { presenceTone } from "../utils/presence";
import { IconChat, IconMore, IconPhone, IconVideo } from "./icons";
import ChatActions from "./chat/ChatActions";
import ChatGallery, { type GalleryTab } from "./chat/ChatGallery";
import SavedAvatar from "./chat/SavedAvatar";
import { useIsBlocked } from "../store/blocks";
import s from "./PeerPanel.module.css";

export default function PeerPanel() {
  const activeChatId = useChatStore((st) => st.activeChatId);
  const chats = useChatStore((st) => st.chats);
  const currentUser = useAuthStore((st) => st.user);
  const startAudioCall = useCallStore((st) => st.startAudioCall);
  const startVideoCall = useCallStore((st) => st.startVideoCall);
  const callPhase = useCallStore((st) => st.phase);
  const callBusy = callPhase !== "idle" && callPhase !== "ended";
  const [notifyOn, setNotifyOn] = useState(() => getNotifyPrefs().enabled);
  const [mediaTab, setMediaTab] = useState<GalleryTab>("photos");

  const chat = chats.find((c) => c.id === activeChatId);
  const peerId =
    chat?.type === "direct" ? chat.members.find((m) => m.user.id !== currentUser?.id)?.user.id : null;
  const peerPresence = usePresence(peerId);
  const peerStatusText = usePresenceText(peerId);
  const blocked = useIsBlocked(peerId);
  if (!chat || !activeChatId) {
    return (
      <aside className={s.root}>
        <p className={s.mediaEmpty}>Выберите чат, чтобы увидеть профиль собеседника</p>
      </aside>
    );
  }

  const peer =
    chat.type === "group" || chat.type === "saved"
      ? {
          id: null as string | null,
          username: chat.type === "saved" ? "Избранное" : (chat.name ?? "Группа"),
          avatar_url: null as string | null,
        }
      : (() => {
          const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
          return {
            id: other?.id ?? null,
            username: other?.username ?? "Неизвестный",
            avatar_url: other?.avatar_url ?? null,
          };
        })();

  const canCall = chat.type === "direct" && !!peer.id && !callBusy && !blocked;

  return (
    <aside className={s.root}>
      <div className={s.profile}>
        {chat.type === "saved" ? (
          <SavedAvatar size="lg" />
        ) : (
          <UserAvatar username={peer.username} avatarUrl={peer.avatar_url} size="lg" userId={peer.id} />
        )}
        <div className={s.name}>{peer.username}</div>
        <div
          className={`${s.status} ${
            blocked
              ? ""
              : ({ online: s.statusOnline, away: s.statusAway, busy: s.statusBusy, none: "" }[presenceTone(peerPresence) ?? "none"] ?? "")
          }`}
        >
          {chat.type === "group"
            ? "Группа"
            : chat.type === "saved"
              ? "Заметки и пересланное — видите только вы"
              : blocked
                ? "Заблокирован(а)"
                : (peerStatusText ?? "В Quazar")}
        </div>
      </div>

      <div className={s.actions}>
        <button type="button" className={`${s.action} ${s.actionPrimary}`}>
          <IconChat size={18} />
          Чат
        </button>
        {chat.type !== "saved" && (
          <>
            <button
              type="button"
              className={s.action}
              title="Аудиозвонок"
              disabled={!canCall}
              onClick={() => {
                if (peer.id) void startAudioCall(activeChatId, peer.id);
              }}
            >
              <IconPhone size={18} />
              Звонок
            </button>
            <button
              type="button"
              className={s.action}
              title="Видеозвонок"
              disabled={!canCall}
              onClick={() => {
                if (peer.id) void startVideoCall(activeChatId, peer.id);
              }}
            >
              <IconVideo size={18} />
              Видео
            </button>
          </>
        )}
        <ChatActions chat={chat} className={s.action}>
          <IconMore size={18} />
          Ещё
        </ChatActions>
      </div>

      {chat.type !== "saved" && (
        <section className={s.section}>
          <div className={s.sectionTitle}>О себе</div>
          <p className={s.about}>Пользователь Quazar Messager</p>
        </section>
      )}

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
              ["photos", "Фото"],
              ["voice", "Голосовые"],
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
        <ChatGallery chatId={activeChatId} tab={mediaTab} />
      </section>
    </aside>
  );
}
