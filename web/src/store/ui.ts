import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_GLASS_TRANSPARENCY } from "../styles/glass";

export type AppTab = "contacts" | "chats" | "stars" | "calls" | "settings";

interface UiState {
  tab: AppTab;
  /** На мобиле: чат открыт на весь экран. Не персистим — иначе после reload залипает оверлей. */
  mobileChatOpen: boolean;
  /** ПК: правая панель собеседника. */
  peerPanelOpen: boolean;
  favoriteChatIds: string[];
  /** Прозрачность liquid glass, 0..100 %. */
  glassTransparency: number;
  /** Звуки Созвездия: вход и выход, стук, приглашения. */
  starSounds: boolean;
  setTab: (tab: AppTab) => void;
  setMobileChatOpen: (open: boolean) => void;
  setPeerPanelOpen: (open: boolean) => void;
  setGlassTransparency: (value: number) => void;
  setStarSounds: (on: boolean) => void;
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
      glassTransparency: DEFAULT_GLASS_TRANSPARENCY,
      starSounds: true,

      setTab: (tab) => set({ tab, mobileChatOpen: false }),
      setMobileChatOpen: (mobileChatOpen) => set({ mobileChatOpen }),
      setPeerPanelOpen: (peerPanelOpen) => set({ peerPanelOpen }),
      setGlassTransparency: (glassTransparency) => set({ glassTransparency }),
      setStarSounds: (starSounds) => set({ starSounds }),

      toggleFavorite: (chatId) =>
        set((s) => ({
          favoriteChatIds: s.favoriteChatIds.includes(chatId)
            ? s.favoriteChatIds.filter((id) => id !== chatId)
            : [...s.favoriteChatIds, chatId],
        })),

      isFavorite: (chatId) => get().favoriteChatIds.includes(chatId),
    }),
    {
      name: "quazar-ui",
      partialize: (state) => ({
        tab: state.tab,
        peerPanelOpen: state.peerPanelOpen,
        favoriteChatIds: state.favoriteChatIds,
        glassTransparency: state.glassTransparency,
        starSounds: state.starSounds,
      }),
    }
  )
);
