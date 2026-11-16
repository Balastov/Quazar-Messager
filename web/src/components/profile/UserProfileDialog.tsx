import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usersApi } from "../../api/users";
import { chatsApi } from "../../api/chats";
import { useIsBlocked } from "../../store/blocks";
import { useCallStore } from "../../store/call";
import type { User } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { useChatStore } from "../../store/chat";
import { usePresence, usePresenceText } from "../../store/presence";
import { useProfileStore, type ProfileTarget } from "../../store/profile";
import { useStarsStore } from "../../store/stars";
import { useUiStore } from "../../store/ui";
import { presenceTone } from "../../utils/presence";
import { formatRuPhoneDisplay } from "../../utils/phone";
import { showOpenedChat } from "../../chat/showOpenedChat";
import Dialog from "../constellation/Dialog";
import PremiumBadge from "../premium/PremiumBadge";
import OfficialBadge from "../support/OfficialBadge";
import CustomStatusBadge from "../status/CustomStatusBadge";
import UserAvatar from "../UserAvatar";
import { IconChat, IconPhone, IconVideo } from "../icons";
import c from "../constellation/Constellation.module.css";
import s from "./UserProfile.module.css";

/** «5 ноября 2026». */
export function joinedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/** Карточка открытого профиля; ничего не открыто — ничего не рисуем. */
export default function UserProfileHost() {
  const target = useProfileStore((st) => st.target);
  const close = useProfileStore((st) => st.close);
  if (!target) return null;
  // key: другой человек — карточка с чистого листа.
  return createPortal(<UserProfileDialog key={target.userId} target={target} onClose={close} />, document.body);
}

function UserProfileDialog({ target, onClose }: { target: ProfileTarget; onClose: () => void }) {
  const { userId, starId, hint } = target;
  const myId = useAuthStore((st) => st.user?.id);
  const openDirectChat = useChatStore((st) => st.openDirectChat);
  // Уже переписываемся с ним в открытом чате — «Написать» ни к чему.
  const inHisChat = useChatStore((st) => {
    const chat = st.chats.find((c) => c.id === st.activeChatId);
    return chat?.type === "direct" && chat.members.some((m) => m.user.id === userId);
  });
  const tab = useUiStore((st) => st.tab);
  const star = useStarsStore((st) => (starId ? st.details[starId] : undefined));
  const presence = usePresence(userId);
  const presenceText = usePresenceText(userId);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calling, setCalling] = useState(false);
  const blocked = useIsBlocked(userId);
  const callBusy = useCallStore((st) => st.phase !== "idle" && st.phase !== "ended");

  useEffect(() => {
    let cancelled = false;
    usersApi
      .get(userId)
      .then((u) => !cancelled && setUser(u))
      .catch(() => !cancelled && setError("Профиль недоступен"));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const member = star?.members.find((m) => m.user.id === userId);
  const pseudonym = member?.user.pseudonym ?? null;
  // Настоящее имя: с сервера, а пока не пришло — то, что знаем на месте (без псевдонима).
  const name =
    user?.display_name ||
    member?.user.account_display_name ||
    (pseudonym ? null : hint?.display_name) ||
    user?.username ||
    member?.user.username ||
    hint?.username ||
    "…";
  const username = user?.username ?? member?.user.username ?? hint?.username ?? null;
  const avatar = user?.avatar_url ?? member?.user.avatar_url ?? hint?.avatar_url ?? null;
  const premium = user?.is_premium ?? member?.user.is_premium ?? hint?.is_premium ?? false;
  const isMe = userId === myId;
  const tone = presenceTone(presence);
  const canWrite = !isMe && !user?.is_official && !(inHisChat && (tab === "chats" || tab === "contacts"));
  const canCall = !isMe && !user?.is_official;

  // Звонок идёт в личном чате; его нет — заводим. Окно звонка общее, переходить в чат не нужно.
  const call = async (video: boolean) => {
    setCalling(true);
    setError(null);
    try {
      const chat = await chatsApi.createDirect(userId);
      useChatStore.setState((st) => (st.chats.some((c) => c.id === chat.id) ? {} : { chats: [chat, ...st.chats] }));
      const calls = useCallStore.getState();
      onClose();
      await (video ? calls.startVideoCall(chat.id, userId) : calls.startAudioCall(chat.id, userId));
    } catch {
      setError("Не удалось позвонить");
      setCalling(false);
    }
  };
  const callTitle = blocked ? "Вы заблокировали этого человека" : callBusy ? "Сейчас идёт другой звонок" : undefined;

  return (
    <Dialog title="Профиль" onClose={onClose} className={s.dialog}>
      <div className={s.card}>
        <UserAvatar username={name} avatarUrl={avatar} size="lg" userId={userId} className={s.avatar} />
        <div className={s.name}>
          {name}
          {premium && <PremiumBadge size={18} />}
          {user?.is_official && <OfficialBadge size={18} />}
        </div>
        {username && <div className={s.nick}>@{username}</div>}
        {pseudonym && (
          <div className={s.pseudonym}>
            Псевдоним в «{star?.name}»: <b>{pseudonym}</b>
          </div>
        )}
        {isMe ? (
          <div className={s.status}>Это вы</div>
        ) : (
          presenceText && (
            <div
              className={`${s.status} ${
                { online: s.online, away: s.away, busy: s.busy, none: "" }[tone ?? "none"] ?? ""
              }`}
            >
              {presenceText}
            </div>
          )
        )}
        <CustomStatusBadge userId={userId} />
      </div>

      {error && <p className={c.error}>{error}</p>}

      {(user?.phone || user?.created_at) && (
        <dl className={s.facts}>
          {user?.phone && (
            <div>
              <dt>Телефон</dt>
              <dd>{formatRuPhoneDisplay(user.phone)}</dd>
            </div>
          )}
          {user?.created_at && (
            <div>
              <dt>В Quazar</dt>
              <dd>с {joinedDate(user.created_at)}</dd>
            </div>
          )}
        </dl>
      )}

      {(canWrite || canCall) && (
        <div className={s.actions}>
          {canWrite && (
            <button
              type="button"
              className={`${s.action} ${s.actionPrimary}`}
              onClick={() => {
                onClose();
                void showOpenedChat(() => openDirectChat(userId));
              }}
            >
              <IconChat size={18} />
              Написать
            </button>
          )}
          {canCall && (
            <>
              <button
                type="button"
                className={s.action}
                disabled={calling || callBusy || blocked}
                title={callTitle ?? "Аудиозвонок"}
                onClick={() => void call(false)}
              >
                <IconPhone size={18} />
                Звонок
              </button>
              <button
                type="button"
                className={s.action}
                disabled={calling || callBusy || blocked}
                title={callTitle ?? "Видеозвонок"}
                onClick={() => void call(true)}
              >
                <IconVideo size={18} />
                Видео
              </button>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
