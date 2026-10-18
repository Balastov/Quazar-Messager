/**
 * Правила Созвездия на клиенте — только чтобы показывать доступные кнопки.
 * Решает всё равно сервер (backend/app/core/stars.py).
 */
import axios from "axios";
import type { RoomKind, StarDetail, StarKind, StarPerm, StarRole } from "../../api/stars";
import { roleRank } from "../../store/stars";

export const ROLE_LABEL: Record<StarRole, string> = {
  owner: "Владелец",
  admin: "Админ",
  moderator: "Модератор",
  member: "Участник",
};

export const KIND_LABEL: Record<StarKind, string> = {
  gaming: "Игры",
  work: "Работа",
};

export const ROOM_LABEL: Record<RoomKind, string> = {
  coworking: "Коворкинг",
  meeting: "Переговорная",
  smoking: "Курилка",
  kitchen: "Кухня",
  custom: "Другое",
  lobby: "Зал ожидания",
};

/** Типы комнат, которые можно выбрать (зал ожидания создаётся сам). */
export const SELECTABLE_ROOM_KINDS: RoomKind[] = ["coworking", "meeting", "smoking", "kitchen", "custom"];

export const PERM_LABEL: Record<StarPerm, string> = {
  invite: "Приглашать людей",
  delete_messages: "Удалять чужие сообщения",
  kick: "Выгонять участников",
  manage_channels: "Создавать и удалять Спутники и Планеты",
  voice_moderate: "Выключать микрофон и выводить с Планет",
  edit_map: "Редактировать карту офиса",
  admit: "Впускать в закрытые комнаты и входить в них без стука",
};

export const PERM_ORDER: StarPerm[] = [
  "invite",
  "delete_messages",
  "kick",
  "manage_channels",
  "voice_moderate",
  "edit_map",
  "admit",
];

/** Участнику можно выдать только приглашения. */
export const MEMBER_GRANTABLE: StarPerm[] = ["invite"];

export const GAMING_LIMITS = { satellite: 3, planet: 5 } as const;

export function can(detail: StarDetail | undefined, perm: StarPerm): boolean {
  return !!detail?.my_permissions.includes(perm);
}

export function outranks(a: StarRole, b: StarRole): boolean {
  return roleRank(a) > roleRank(b);
}

/** Чужой показ экрана останавливают модератор, админ и владелец — у тех, кто ниже рангом. */
export function canStopScreen(detail: StarDetail, target: StarRole): boolean {
  return roleRank(detail.my_role) >= roleRank("moderator") && outranks(detail.my_role, target);
}

export function canKick(detail: StarDetail, target: StarRole): boolean {
  return can(detail, "kick") && outranks(detail.my_role, target);
}

export function canBan(me: StarRole, target: StarRole): boolean {
  return (me === "owner" || me === "admin") && outranks(me, target);
}

/** Роли, которые я могу назначить участнику с ролью target (кроме текущей). */
export function assignableRoles(me: StarRole, target: StarRole): Exclude<StarRole, "owner">[] {
  if (!outranks(me, target)) return [];
  const roles: Exclude<StarRole, "owner">[] = me === "owner" ? ["admin", "moderator", "member"] : [];
  if (me === "admin" && target !== "admin") roles.push("moderator", "member");
  return roles.filter((r) => r !== target);
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function apiError(err: unknown, fallback = "Не получилось. Попробуйте ещё раз."): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
    if (!err.response) return "Нет связи с сервером";
  }
  return fallback;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString("ru", { day: "numeric", month: "short" })}, ${time}`;
}
