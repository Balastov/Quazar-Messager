import { create } from "zustand";
import { adminApi, type AdminStats } from "../api/admin";
import { socket } from "../ws/socket";

interface AdminState {
  /** Владелец ли я ресурса (null — ещё не знаем). Сервер остальным отвечает 404. */
  isSuper: boolean | null;
  /** Новости об обновлениях ждут одобрения — отметка на «Чёрной дыре». */
  newsDrafts: number;
  /** Непрочитанные командой сообщения в обращениях — число на «Чёрной дыре». */
  ticketsUnread: number;
  check: () => Promise<void>;
  /** Свежая сводка из «Чёрной дыры». */
  setStats: (stats: AdminStats) => void;
  reset: () => void;
}

const fromStats = (stats: AdminStats) => ({ newsDrafts: stats.news_drafts ?? 0, ticketsUnread: stats.unread_tickets ?? 0 });

export const useAdminStore = create<AdminState>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Новое сообщение в обращении или его прочитал кто-то из команды — пересчитываем (пачку — один раз).
  socket.on((event) => {
    if (event.type !== "support_ticket" || !get().isSuper) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void adminApi.me().then((stats) => get().isSuper && set(fromStats(stats))).catch(() => {});
    }, 300);
  });

  return {
    isSuper: null,
    newsDrafts: 0,
    ticketsUnread: 0,
    check: async () => {
      try {
        const stats = await adminApi.me();
        set({ isSuper: true, ...fromStats(stats) });
      } catch {
        set({ isSuper: false, newsDrafts: 0, ticketsUnread: 0 });
      }
    },
    setStats: (stats) => set(fromStats(stats)),
    reset: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      set({ isSuper: null, newsDrafts: 0, ticketsUnread: 0 });
    },
  };
});
