import { create } from "zustand";
import { socket } from "../ws/socket";
import { createTypingThrottle, TYPING_SHOW_MS } from "../chat/typing";

/**
 * Кто сейчас печатает — в чатах («chat:<id>») и Спутниках («sat:<channelId>»).
 * Подпись гаснет сама через TYPING_SHOW_MS или сразу, как пришло сообщение от этого человека.
 */
interface TypingState {
  /** Ключ места → кто печатает. */
  byKey: Record<string, string[]>;
  mark: (key: string, userId: string) => void;
  clear: (key: string, userId: string) => void;
}

export const chatTypingKey = (chatId: string) => `chat:${chatId}`;
export const satelliteTypingKey = (channelId: string) => `sat:${channelId}`;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const throttle = createTypingThrottle();

export const useTypingStore = create<TypingState>((set, get) => ({
  byKey: {},

  mark: (key, userId) => {
    const timerKey = `${key}|${userId}`;
    clearTimeout(timers.get(timerKey));
    timers.set(
      timerKey,
      setTimeout(() => get().clear(key, userId), TYPING_SHOW_MS)
    );
    set((s) => {
      const list = s.byKey[key] ?? [];
      return list.includes(userId) ? {} : { byKey: { ...s.byKey, [key]: [...list, userId] } };
    });
  },

  clear: (key, userId) => {
    const timerKey = `${key}|${userId}`;
    clearTimeout(timers.get(timerKey));
    timers.delete(timerKey);
    set((s) => {
      const list = s.byKey[key];
      if (!list?.includes(userId)) return {};
      const rest = list.filter((id) => id !== userId);
      const byKey = { ...s.byKey };
      if (rest.length) byKey[key] = rest;
      else delete byKey[key];
      return { byKey };
    });
  },
}));

const NOBODY: string[] = [];

/** Кто печатает в этом месте (без меня — сервер мне мои же события не шлёт). */
export function useTyping(key: string | null): string[] {
  return useTypingStore((s) => (key ? (s.byKey[key] ?? NOBODY) : NOBODY));
}

/** Сообщить, что я набираю текст в чате. */
export function sendChatTyping(chatId: string) {
  if (throttle.shouldSend(chatTypingKey(chatId))) socket.send({ type: "typing", chat_id: chatId });
}

/** Сообщить, что я набираю текст в Спутнике. */
export function sendSatelliteTyping(starId: string, channelId: string) {
  if (throttle.shouldSend(satelliteTypingKey(channelId))) {
    socket.send({ type: "typing", star_id: starId, channel_id: channelId });
  }
}

/** Сообщение ушло — следующий набор сообщаем сразу, без ожидания. */
export function resetTypingThrottle(key: string) {
  throttle.reset(key);
}

socket.on((event) => {
  const { mark, clear } = useTypingStore.getState();
  switch (event.type) {
    case "typing":
      mark(chatTypingKey(event.chat_id), event.user_id);
      break;
    case "star_typing":
      mark(satelliteTypingKey(event.channel_id), event.user_id);
      break;
    case "new_message":
      clear(chatTypingKey(event.chat_id), event.sender_id);
      break;
    case "star_message":
      if (event.message.sender) clear(satelliteTypingKey(event.message.channel_id), event.message.sender.id);
      break;
  }
});
