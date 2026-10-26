import { useState } from "react";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { useCallStore } from "../store/call";
import { CHAT_DEFAULT, chatLevel, levelSummary, settingKey, useNotifyStore } from "../notifications/levels";
import NotifyDialog from "./NotifyDialog";
import CustomStatusBadge from "./status/CustomStatusBadge";
import UserAvatar from "./UserAvatar";
import { usePresence, usePresenceText } from "../store/presence";
import { presenceTone } from "../utils/presence";
import { IconChat, IconMore, IconPhone, IconVideo } from "./icons";
import ChatActions from "./chat/ChatActions";
import ChatGallery, { type GalleryTab } from "./chat/ChatGallery";
import SavedAvatar from "./chat/SavedAvatar";
import { useIsBlocked } from "../store/blocks";
import s from "./PeerPanel.module.css";
import { displayName } from "../utils/profile";

export default function PeerPanel() {
  const activeChatId = useChatStore((st) => st.activeChatId);
  const chats = useChatStore((st) => st.chats);
  const currentUser = useAuthStore((st) => st.user);
  const startAudioCall = useCallStore((st) => st.startAudioCall);
  const startVideoCall = useCallStore((st) => st.startVideoCall);
  const callPhase = useCallStore((st) => st.phase);
  const callBusy = callPhase !== "idle" && callPhase !== "ended";
  const notifySettings = useNotifyStore((st) => st.settings);
  const [notifyOpen, setNotifyOpen] = useState(false);
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
          nick: null as string | null,
          avatar_url: null as string | null,
        }
      : (() => {
          const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
          return {
            id: other?.id ?? null,
            username: displayName(other) ?? "Неизвестный",
            nick: other?.username ?? null,
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
        {peer.nick && <div className={s.nick}>@{peer.nick}</div>}
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
        {peer.id && <CustomStatusBadge userId={peer.id} />}
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

      {chat.type !== "saved" && (
        <button
          type="button"
          className={s.row}
          onClick={() => setNotifyOpen(true)}
          style={{ width: "100%", cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
        >
          <span>Уведомления</span>
          <span className={s.status}>
            {levelSummary(chatLevel(notifySettings, chat.id), notifySettings[settingKey("chat", chat.id)])}
          </span>
        </button>
      )}
      {notifyOpen && (
        <NotifyDialog
          scope="chat"
          targetId={chat.id}
          title={`Уведомления: ${peer.username}`}
          inherited={CHAT_DEFAULT}
          mentions={chat.type === "group"}
          onClose={() => setNotifyOpen(false)}
        />
      )}

      <section className={s.section}>
        <div className={s.mediaTabs}>
          {(
            [
              ["photos", "Фото"],
              ["voice", "Голосовые"],
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
        <ChatGallery chatId={activeChatId} tab={mediaTab} />
      </section>
    </aside>
  );
}
