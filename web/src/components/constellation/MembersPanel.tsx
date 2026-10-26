import { useCallback, useMemo, useState } from "react";
import { starsApi, type StarDetail, type StarMember } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useChatStore } from "../../store/chat";
import { usePresenceStore } from "../../store/presence";
import { useUiStore } from "../../store/ui";
import { presenceTone } from "../../utils/presence";
import UserAvatar from "../UserAvatar";
import { IconBack, IconChat } from "../icons";
import { groupMembers } from "./members";
import { apiError, can, outranks, ROLE_LABEL } from "./rules";
import MessageMenu, { type MenuAction } from "../messages/MessageMenu";
import MyTags, { TagChip, memberColor } from "./MyTags";
import Dialog from "./Dialog";
import { formatWhen } from "../../chat/when";
import g from "./Gaming.module.css";
import w from "./Work.module.css";
import { browserTimeZone, effectiveSchedule, memberWorkState } from "../../chat/workhours";

const TIMEOUTS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 минут" },
  { minutes: 60, label: "1 час" },
  { minutes: 1440, label: "1 день" },
  { minutes: 10080, label: "1 неделя" },
];
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
  const [menu, setMenu] = useState<{ member: StarMember; x: number; y: number } | null>(null);
  const [tagsFor, setTagsFor] = useState<StarMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const isAdmin = detail.my_role === "owner" || detail.my_role === "admin";
  const hasTags = (detail.tags ?? []).length > 0;

  const memberActions = (member: StarMember): MenuAction[] => {
    const actions: MenuAction[] = [];
    if (can(detail, "kick") && outranks(detail.my_role, member.role)) {
      const timedOut = member.timeout_until && Date.parse(member.timeout_until) > Date.now();
      if (timedOut) {
        actions.push({
          label: "Снять тайм-аут",
          onClick: () => void starsApi.timeout(detail.id, member.user.id, null).catch((err) => setError(apiError(err))),
        });
      }
      for (const t of TIMEOUTS) {
        actions.push({
          label: `Тайм-аут: ${t.label}`,
          danger: true,
          onClick: () => void starsApi.timeout(detail.id, member.user.id, t.minutes).catch((err) => setError(apiError(err))),
        });
      }
    }
    if (isAdmin && hasTags) actions.unshift({ label: "Роли…", onClick: () => setTagsFor(member) });
    return actions;
  };

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
        <div style={{ padding: "4px 12px 8px" }}>
          <MyTags detail={detail} />
        </div>
        {error && <div className={s.error} style={{ padding: "0 12px 8px" }}>{error}</div>}
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
                    <span className={s.memberName} style={{ color: memberColor(detail, member.user.id) }}>
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
                    {!!member.tag_ids?.length && (
                      <span className={g.tagList}>
                        {(detail.tags ?? [])
                          .filter((t) => member.tag_ids!.includes(t.id))
                          .map((t) => (
                            <TagChip key={t.id} tag={t} />
                          ))}
                      </span>
                    )}
                    {member.timeout_until && Date.parse(member.timeout_until) > Date.now() && (
                      <span className={s.memberStatus}>⏳ тайм-аут до {formatWhen(member.timeout_until)}</span>
                    )}
                    {(() => {
                      const work = memberWorkState(detail, member);
                      if (!work) return null;
                      const tz = effectiveSchedule(detail.work_hours, member.work_schedule).tz;
                      if (work.working && tz === browserTimeZone()) return null;
                      return (
                        <span className={work.working ? w.workClock : w.offHours} title={tz}>
                          🕒 {work.time}
                          {work.working ? " · местное время" : " · не в рабочее время"}
                        </span>
                      );
                    })()}
                    {room !== undefined && (
                      <span className={s.memberWhere}>
                        {nouns.inside} «{room}»
                      </span>
                    )}
                  </div>
                  {!isMe && memberActions(member).length > 0 && (
                    <button
                      type="button"
                      className={s.memberWrite}
                      aria-label={`Действия: ${member.user.username}`}
                      title="Модерация и роли"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu({ member, x: r.right - 220, y: r.bottom + 4 });
                      }}
                    >
                      ⋯
                    </button>
                  )}
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
      {menu && <MessageMenu at={menu} reaction={null} actions={memberActions(menu.member)} onClose={closeMenu} />}
      {tagsFor && (
        <Dialog title={`Роли: ${tagsFor.user.username}`} onClose={() => setTagsFor(null)}>
          <MemberTags detail={detail} userId={tagsFor.user.id} onError={setError} />
        </Dialog>
      )}
    </aside>
  );
}

/** Выдать или снять свои роли участнику (владелец и админы). */
function MemberTags({ detail, userId, onError }: { detail: StarDetail; userId: string; onError: (e: string) => void }) {
  const current = detail.members.find((m) => m.user.id === userId)?.tag_ids ?? [];
  return (
    <div className={g.tagList}>
      {(detail.tags ?? []).map((t) => (
        <TagChip
          key={t.id}
          tag={t}
          active={current.includes(t.id)}
          onClick={() => {
            const call = current.includes(t.id)
              ? starsApi.takeTag(detail.id, userId, t.id)
              : starsApi.giveTag(detail.id, userId, t.id);
            void call.catch((err) => onError(apiError(err)));
          }}
        />
      ))}
    </div>
  );
}
