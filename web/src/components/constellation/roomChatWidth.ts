/** Ширина чата комнаты на компьютере: её тянут мышью за левый край, запоминаем на этом устройстве. */

const KEY = "quazar-room-chat-width";
export const CHAT_MIN = 280;
export const CHAT_MAX = 900;
/** Сколько оставить самой комнате слева. */
export const ROOM_MIN = 320;
export const KEY_STEP = 24;

/** Допустимая ширина при такой ширине всей раскладки (комната + чат). */
export function clampChatWidth(width: number, layoutWidth: number): number {
  const max = Math.max(CHAT_MIN, Math.min(CHAT_MAX, layoutWidth - ROOM_MIN));
  return Math.round(Math.min(max, Math.max(CHAT_MIN, width)));
}

export function maxChatWidth(layoutWidth: number): number {
  return clampChatWidth(Number.POSITIVE_INFINITY, layoutWidth);
}

/** Сохранённая ширина или null — тогда ширину задаёт вёрстка (360 / 300 px). */
export function savedChatWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value >= CHAT_MIN && value <= CHAT_MAX ? value : null;
  } catch {
    return null;
  }
}

export function saveChatWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(width)));
  } catch {
    // Хранилище недоступно — ширина продержится до перезагрузки.
  }
}
