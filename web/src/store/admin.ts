import { create } from "zustand";
import { adminApi, type AdminStats } from "../api/admin";

interface AdminState {
  /** Владелец ли я ресурса (null — ещё не знаем). Сервер остальным отвечает 404. */
  isSuper: boolean | null;
  /** Новости об обновлениях ждут одобрения — отметка на «Чёрной дыре». */
  newsDrafts: number;
  check: () => Promise<void>;
  /** Свежая сводка из «Чёрной дыры». */
  setStats: (stats: AdminStats) => void;
  reset: () => void;
}

export const useAdminStore = create<AdminState>((set) => ({
  isSuper: null,
  newsDrafts: 0,
  check: async () => {
    try {
      const stats = await adminApi.me();
      set({ isSuper: true, newsDrafts: stats.news_drafts ?? 0 });
    } catch {
      set({ isSuper: false, newsDrafts: 0 });
    }
  },
  setStats: (stats) => set({ newsDrafts: stats.news_drafts ?? 0 }),
  reset: () => set({ isSuper: null, newsDrafts: 0 }),
}));
