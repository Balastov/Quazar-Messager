import { useMemo } from "react";
import type { StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useChatStore } from "../../store/chat";
import { usePresenceStore } from "../../store/presence";
import { useUiStore } from "../../store/ui";
import { presenceTone } from "../../utils/presence";
import UserAvatar from "../UserAvatar";
import { IconBack, IconChat } from "../icons";
import { groupMembers } from "./members";
import { ROLE_LABEL } from "./rules";
import { placeNouns } from "./words";
import s from "./Constellation.module.css";

interface Props {
  detail: StarDetail;
  onClose: () => void;
  /** На телефоне панель на весь экран — со стрелкой «назад». */
  fullscreen?: boolean;
}

/** Участники Звезды со статусами: кто в сети, кто отошёл, кто где сейчас. */
export default function MembersPanel({ detail, onClose, fullscreen = false }: Props) {
  const myId = useAuthStore((st) => st.user?.id);
  const byId = usePresenceStore((st) => st.byId);
  const minute = usePresenceStore((st) => st.minute);
  const openDirectChat = useChatStore((st) => st.openDirectChat);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- minute: «12 мин назад» пересчитывается
  const groups = useMemo(() => groupMembers(detail.members, byId, myId), [detail.members, byId, myId, minute]);

  // Кто на какой Планете / в какой Комнате прямо сейчас.
  const nouns = placeNouns(detail.kind);
  const whereIs = useMemo(() => {
    const names = new Map(detail.channels.map((c) => [c.id, c.name]));
    const at = new Map<string, string>();
    for (const [channelId, people] of Object.entries(detail.voice ?? {})) {
      for (const p of people) at.set(p.user_id, names.get(channelId) ?? "");
    }
    return at;
  }, [detail.voice, detail.channels]);

  const write = async (userId: string) => {
    await openDirectChat(userId);
    useUiStore.getState().setTab("chats");
    useUiStore.getState().setMobileChatOpen(true);
  };

  return (
    <aside className={fullscreen ? s.membersFull : s.membersPanel} aria-label="Участники Звезды">
      <div className={s.membersHeader}>
        {fullscreen && (
          <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <span className={s.membersTitle}>Участники · {detail.member_count}</span>
        {!fullscreen && (
          <button type="button" className={s.close} onClick={onClose} aria-label="Скрыть участников">
            ✕
          </button>
        )}
      </div>
      <div className={s.membersList}>
        {groups.map((group) => (
          <section key={group.key} className={s.membersGroup}>
            <h4 className={s.membersGroupTitle}>
              {group.title} — {group.rows.length}
            </h4>
            {group.rows.map(({ member, status, text, isMe }) => {
              const tone = presenceTone(status);
              const room = whereIs.get(member.user.id);
              return (
                <div
                  key={member.user.id}
                  className={`${s.memberRow} ${group.key === "offline" ? s.memberRowOffline : ""}`}
                >
                  <UserAvatar
                    username={member.user.username}
                    avatarUrl={member.user.avatar_url}
                    size="sm"
                    userId={member.user.id}
                  />
                  <div className={s.memberMain}>
                    <span className={s.memberName}>
                      {member.user.username}
                      {isMe ? " (вы)" : ""}
                      {member.role !== "member" && <span className={s.memberRole}>{ROLE_LABEL[member.role]}</span>}
                    </span>
                    {text && (
                      <span
                        className={`${s.memberStatus} ${
                          tone === "online"
                            ? s.presenceOnline
                            : tone === "away"
                              ? s.presenceAway
                              : tone === "busy"
                                ? s.presenceBusy
                                : ""
                        }`}
                      >
                        {text}
                      </span>
                    )}
                    {room !== undefined && (
                      <span className={s.memberWhere}>
                        {nouns.inside} «{room}»
                      </span>
                    )}
                  </div>
                  {!isMe && (
                    <button
                      type="button"
                      className={s.memberWrite}
                      onClick={() => void write(member.user.id)}
                      aria-label={`Написать ${member.user.username}`}
                      title="Написать"
                    >
                      <IconChat size={17} />
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
