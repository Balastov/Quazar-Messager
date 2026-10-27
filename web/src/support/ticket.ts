/**
 * Обращение в поддержку (backend/app/core/support.py). В чате с Quazar_Admin_bot — карточка
 * «TKT1:{json}»: открытый текст, чат поддержки не шифруется — его читает команда Квазара.
 */
import type { ImageRef } from "../attachments/image";

export const TICKET_PREFIX = "TKT1:";

export type TicketKind = "idea" | "question" | "bug";
export type TicketStatus = "queued" | "in_progress" | "done";

export interface TicketCard {
  id: string;
  number: number;
  kind: TicketKind;
  text: string;
  images: ImageRef[];
  status: TicketStatus;
}

export const KINDS: { value: TicketKind; label: string; icon: string; hint: string }[] = [
  { value: "idea", label: "Предложение", icon: "💡", hint: "Что добавить или сделать удобнее" },
  { value: "question", label: "Вопрос", icon: "❓", hint: "Как что-то сделать в Квазаре" },
  { value: "bug", label: "Ошибка", icon: "🐞", hint: "Что-то работает не так" },
];

export const KIND_LABEL: Record<TicketKind, string> = { idea: "Предложение", question: "Вопрос", bug: "Ошибка" };
export const KIND_ICON: Record<TicketKind, string> = { idea: "💡", question: "❓", bug: "🐞" };
export const STATUS_LABEL: Record<TicketStatus, string> = {
  queued: "В очереди",
  in_progress: "В работе",
  done: "Готово",
};
export const STATUSES: TicketStatus[] = ["queued", "in_progress", "done"];

/** Картинок в одном обращении. */
export const MAX_TICKET_IMAGES = 5;
export const TICKET_TEXT_MAX = 4000;

const isKind = (v: unknown): v is TicketKind => v === "idea" || v === "question" || v === "bug";
const isStatus = (v: unknown): v is TicketStatus => v === "queued" || v === "in_progress" || v === "done";

export function parseTicket(payload: string): TicketCard | null {
  if (!payload.startsWith(TICKET_PREFIX)) return null;
  try {
    const raw = JSON.parse(payload.slice(TICKET_PREFIX.length));
    if (typeof raw?.id !== "string" || !Number.isFinite(raw.number) || !isKind(raw.kind) || !isStatus(raw.status)) {
      return null;
    }
    return {
      id: raw.id,
      number: raw.number,
      kind: raw.kind,
      text: typeof raw.text === "string" ? raw.text : "",
      images: Array.isArray(raw.images) ? raw.images : [],
      status: raw.status,
    };
  } catch {
    return null;
  }
}

/** Для списка чатов и цитат: «🐞 Ошибка №12: текст…». */
export function ticketPreview(t: TicketCard): string {
  return `${KIND_ICON[t.kind]} ${KIND_LABEL[t.kind]} №${t.number}${t.text ? `: ${t.text}` : ""}`;
}
