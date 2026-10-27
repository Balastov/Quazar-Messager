/**
 * Обращение в поддержку — карточка «TKT1:{json}» в чате с Quazar_Admin_bot
 * (backend/app/core/support.py, web/src/support/ticket.ts). Открытый текст: чат без E2E.
 */
const PREFIX = 'TKT1:';

const KIND: Record<string, string> = {idea: '💡 Предложение', question: '❓ Вопрос', bug: '🐞 Ошибка'};
const STATUS: Record<string, string> = {queued: 'В очереди', in_progress: 'В работе', done: 'Готово'};

export interface TicketCard {
  number: number;
  kind: string;
  text: string;
  images: number;
  status: string;
}

export function parseTicket(payload: string): TicketCard | null {
  if (!payload.startsWith(PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(payload.slice(PREFIX.length));
    if (!Number.isFinite(raw?.number) || !KIND[raw.kind] || !STATUS[raw.status]) {
      return null;
    }
    return {
      number: raw.number,
      kind: raw.kind,
      text: typeof raw.text === 'string' ? raw.text : '',
      images: Array.isArray(raw.images) ? raw.images.length : 0,
      status: raw.status,
    };
  } catch {
    return null;
  }
}

/** «🐞 Ошибка №12: текст» — для цитат. */
export function ticketPreview(t: TicketCard): string {
  return `${KIND[t.kind]} №${t.number}${t.text ? `: ${t.text}` : ''}`;
}

/** Карточка в ленте — текстом: тип, номер, статус, текст, сколько картинок. */
export function ticketText(t: TicketCard): string {
  const lines = [`${KIND[t.kind]} №${t.number} · ${STATUS[t.status]}`];
  if (t.text) {
    lines.push(t.text);
  }
  if (t.images) {
    lines.push(`🖼 Картинок: ${t.images} — посмотреть можно в веб-версии`);
  }
  return lines.join('\n');
}
