/**
 * Участники Звезды по статусу: «В сети» (в т.ч. «на встрече», «не беспокоить»), «Отошли»,
 * «Не в сети». Внутри группы — сначала владелец, админы, модераторы, потом по имени.
 */
import type { StarMember } from "../../api/stars";
import { roleRank } from "../../store/stars";
import { presenceText, type PresenceStatus } from "../../utils/presence";

export type MemberGroupKey = "online" | "away" | "offline";

export interface MemberRow {
  member: StarMember;
  status: PresenceStatus | undefined;
  /** «в сети», «отошёл(ла) 12 мин назад», «на встрече до 15:00», «был(а) вчера в 21:40». */
  text: string | null;
  isMe: boolean;
}

export interface MemberGroup {
  key: MemberGroupKey;
  title: string;
  rows: MemberRow[];
}

const TITLES: Record<MemberGroupKey, string> = {
  online: "В сети",
  away: "Отошли",
  offline: "Не в сети",
};

export function groupMembers(
  members: StarMember[],
  byId: Record<string, PresenceStatus>,
  myId: string | undefined,
  now = new Date()
): MemberGroup[] {
  const groups: Record<MemberGroupKey, MemberRow[]> = { online: [], away: [], offline: [] };
  for (const member of members) {
    const isMe = member.user.id === myId;
    let status = byId[member.user.id];
    // Себя вы видите, даже если сводка ещё не пришла: вы точно здесь.
    if (isMe && !status) status = { status: "online", online: true, awaySince: null, lastSeen: null, manual: null };
    const key: MemberGroupKey =
      status?.status === "online" ? "online" : status?.status === "away" ? "away" : "offline";
    groups[key].push({ member, status, text: presenceText(status, now), isMe });
  }
  const order = (a: MemberRow, b: MemberRow) =>
    roleRank(b.member.role) - roleRank(a.member.role) ||
    a.member.user.username.localeCompare(b.member.user.username, "ru");
  return (Object.keys(groups) as MemberGroupKey[])
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, title: TITLES[key], rows: groups[key].sort(order) }));
}
