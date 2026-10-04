import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppTab = "contacts" | "chats" | "calls" | "settings";

interface UiState {
  tab: AppTab;
  /** На мобиле: чат открыт на весь экран. */
  mobileChatOpen: boolean;
  /** ПК: правая панель собеседника. */
  peerPanelOpen: boolean;
  favoriteChatIds: string[];
  setTab: (tab: AppTab) => void;
  setMobileChatOpen: (open: boolean) => void;
  setPeerPanelOpen: (open: boolean) => void;
  toggleFavorite: (chatId: string) => void;
  isFavorite: (chatId: string) => boolean;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      tab: "chats",
      mobileChatOpen: false,
      peerPanelOpen: true,
      favoriteChatIds: [],

      setTab: (tab) => set({ tab, mobileChatOpen: false }),
      setMobileChatOpen: (mobileChatOpen) => set({ mobileChatOpen }),
      setPeerPanelOpen: (peerPanelOpen) => set({ peerPanelOpen }),

      toggleFavorite: (chatId) =>
        set((s) => ({
          favoriteChatIds: s.favoriteChatIds.includes(chatId)
            ? s.favoriteChatIds.filter((id) => id !== chatId)
            : [...s.favoriteChatIds, chatId],
        })),

      isFavorite: (chatId) => get().favoriteChatIds.includes(chatId),
    }),
    { name: "quazar-ui" }
  )
);
