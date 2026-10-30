import { useMemo } from "react";
import type { StarDetail } from "../../api/stars";
import { isAllWord } from "../../chat/mentions";
import type { MentionKind } from "../LinkifiedText";
import type { MentionOption } from "../messages/MentionSuggest";
import { isStaff } from "../../store/stars";

function people(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} человека`;
  return `${n} человек`;
}

type MentionDetail = Pick<StarDetail, "members" | "tags" | "my_role">;

/** Что подсказать кроме ников: группы (роли с именем для упоминания), а модераторам — @here и @channel. */
export function starMentionOptions(detail: MentionDetail): MentionOption[] {
  const groups = (detail.tags ?? [])
    .filter((t) => t.handle)
    .map((t) => {
      const count = detail.members.filter((mb) => mb.tag_ids?.includes(t.id)).length;
      return { name: t.handle!, hint: `${t.name} · ${people(count)}` };
    });
  if (!isStaff(detail.my_role)) return groups;
  return [...groups, { name: "here", hint: "кто сейчас в сети" }, { name: "channel", hint: "всем участникам" }];
}

/** Подсветка @имени: «me» — меня или мою группу, «other» — других, null — не упоминание. */
export function starMentionKind(detail: MentionDetail, myId: string | undefined): MentionKind {
  const names = new Map(detail.members.map((mb) => [mb.user.username.toLowerCase(), mb.user.id]));
  const mine = new Set(detail.members.find((mb) => mb.user.id === myId)?.tag_ids ?? []);
  const handles = new Map(
    (detail.tags ?? []).filter((t) => t.handle).map((t) => [t.handle!.toLowerCase(), t.id] as const)
  );
  return (name) => {
    const key = name.toLowerCase();
    if (isAllWord(key)) return "other";
    // Ник важнее группы — как на сервере.
    const id = names.get(key);
    if (id) return id === myId ? "me" : "other";
    const tagId = handles.get(key);
    if (tagId) return mine.has(tagId) ? "me" : "other";
    return null;
  };
}

/**
 * Упоминания в Звезде: ники участников, группы и @here/@channel.
 * Те же правила на сервере — backend/app/api/stars.py → _mentions.
 */
export function useStarMentions(detail: StarDetail, myId: string | undefined) {
  const names = useMemo(
    () => detail.members.filter((mb) => mb.user.id !== myId).map((mb) => mb.user.username),
    [detail.members, myId]
  );
  const options = useMemo(
    () => starMentionOptions(detail),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.members, detail.tags, detail.my_role]
  );
  const kind = useMemo(
    () => starMentionKind(detail, myId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.members, detail.tags, myId]
  );
  return { names, options, kind };
}
