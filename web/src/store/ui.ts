import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_GLASS_TRANSPARENCY } from "../styles/glass";

export type AppTab = "contacts" | "chats" | "stars" | "calls" | "settings" | "blackhole";

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
  /** «Отошёл» по системному детектору простоя (Chrome/Edge на ПК, с разрешения). */
  systemIdle: boolean;
  /** Через сколько минут без действий — «отошёл». */
  idleMinutes: number;
  /** Панель «Участники» в Созвездии открыта (на ПК). */
  starMembersOpen: boolean;
  /** Свёрнутые этажи в списке комнат Рабочих Звёзд. */
  collapsedFloorIds: string[];
  setTab: (tab: AppTab) => void;
  setMobileChatOpen: (open: boolean) => void;
  setPeerPanelOpen: (open: boolean) => void;
  setGlassTransparency: (value: number) => void;
  setStarSounds: (on: boolean) => void;
  setSystemIdle: (on: boolean) => void;
  setIdleMinutes: (minutes: number) => void;
  setStarMembersOpen: (open: boolean) => void;
  toggleFloor: (floorId: string) => void;
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
      systemIdle: false,
      idleMinutes: 5,
      starMembersOpen: false,
      collapsedFloorIds: [],

      setTab: (tab) => set({ tab, mobileChatOpen: false }),
      setMobileChatOpen: (mobileChatOpen) => set({ mobileChatOpen }),
      setPeerPanelOpen: (peerPanelOpen) => set({ peerPanelOpen }),
      setGlassTransparency: (glassTransparency) => set({ glassTransparency }),
      setStarSounds: (starSounds) => set({ starSounds }),
      setSystemIdle: (systemIdle) => set({ systemIdle }),
      setIdleMinutes: (idleMinutes) => set({ idleMinutes }),
      setStarMembersOpen: (starMembersOpen) => set({ starMembersOpen }),
      toggleFloor: (floorId) =>
        set((s) => ({
          collapsedFloorIds: s.collapsedFloorIds.includes(floorId)
            ? s.collapsedFloorIds.filter((id) => id !== floorId)
            : [...s.collapsedFloorIds, floorId],
        })),

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
        systemIdle: state.systemIdle,
        idleMinutes: state.idleMinutes,
        starMembersOpen: state.starMembersOpen,
        collapsedFloorIds: state.collapsedFloorIds,
      }),
    }
  )
);
