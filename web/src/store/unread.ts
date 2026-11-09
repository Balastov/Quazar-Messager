import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UnreadState {
  counts: Record<string, number>;
  mentions: Record<string, number>;
  bump: (chatId: string, mentioned?: boolean) => void;
  clear: (chatId: string) => void;
  /** Счётчики с сервера: там видно и то, что пришло, пока вкладка была закрыта. */
  replace: (counts: Record<string, number>, mentions?: Record<string, number>) => void;
  getCount: (chatId: string) => number;
}

export const useUnreadStore = create<UnreadState>()(
  persist(
    (set, get) => ({
      counts: {},
      mentions: {},

      bump: (chatId, mentioned = false) =>
        set((s) => ({
          counts: { ...s.counts, [chatId]: (s.counts[chatId] ?? 0) + 1 },
          mentions: mentioned ? { ...s.mentions, [chatId]: (s.mentions[chatId] ?? 0) + 1 } : s.mentions,
        })),

      clear: (chatId) =>
        set((s) => {
          if (!s.counts[chatId] && !s.mentions[chatId]) return s;
          const next = { ...s.counts };
          const mentions = { ...s.mentions };
          delete next[chatId];
          delete mentions[chatId];
          return { counts: next, mentions };
        }),

      replace: (counts, mentions = {}) => set({ counts, mentions }),

      getCount: (chatId) => get().counts[chatId] ?? 0,
    }),
    { name: "quazar-unread" }
  )
);
