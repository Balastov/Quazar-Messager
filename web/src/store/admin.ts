import { create } from "zustand";
import { adminApi } from "../api/admin";

/** Владелец ли я ресурса (null — ещё не знаем). Сервер остальным отвечает 404. */
export const useAdminStore = create<{ isSuper: boolean | null; check: () => Promise<void>; reset: () => void }>((set) => ({
  isSuper: null,
  check: async () => {
    try {
      await adminApi.me();
      set({ isSuper: true });
    } catch {
      set({ isSuper: false });
    }
  },
  reset: () => set({ isSuper: null }),
}));
