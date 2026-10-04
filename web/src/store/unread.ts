import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UnreadState {
  counts: Record<string, number>;
  bump: (chatId: string) => void;
  clear: (chatId: string) => void;
  getCount: (chatId: string) => number;
}

export const useUnreadStore = create<UnreadState>()(
  persist(
    (set, get) => ({
      counts: {},

      bump: (chatId) =>
        set((s) => ({
          counts: { ...s.counts, [chatId]: (s.counts[chatId] ?? 0) + 1 },
        })),

      clear: (chatId) =>
        set((s) => {
          if (!s.counts[chatId]) return s;
          const next = { ...s.counts };
          delete next[chatId];
          return { counts: next };
        }),

      getCount: (chatId) => get().counts[chatId] ?? 0,
    }),
    { name: "quazar-unread" }
  )
);
