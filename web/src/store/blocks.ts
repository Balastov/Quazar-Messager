import { create } from "zustand";
import { usersApi, type ReportBody } from "../api/users";
import { socket } from "../ws/socket";

/**
 * Кого я заблокировал. Заблокированный об этом не узнаёт: его сообщения до меня
 * просто не доходят, а звонки выглядят для него как «не в сети».
 */
interface BlocksState {
  ids: string[];
  loaded: boolean;
  load: () => Promise<void>;
  block: (userId: string) => Promise<void>;
  unblock: (userId: string) => Promise<void>;
  report: (userId: string, body: ReportBody) => Promise<void>;
}

export const useBlocksStore = create<BlocksState>((set) => {
  const apply = (userId: string, blocked: boolean) =>
    set((s) => ({
      ids: blocked ? [...new Set([...s.ids, userId])] : s.ids.filter((id) => id !== userId),
    }));

  socket.on((event) => {
    if (event.type === "blocks_changed") apply(event.user_id, event.blocked);
  });

  return {
    ids: [],
    loaded: false,

    load: async () => {
      const users = await usersApi.blocks();
      set({ ids: users.map((u) => u.id), loaded: true });
    },

    block: async (userId) => {
      await usersApi.block(userId);
      apply(userId, true);
    },

    unblock: async (userId) => {
      await usersApi.unblock(userId);
      apply(userId, false);
    },

    report: async (userId, body) => {
      await usersApi.report(userId, body);
      if (body.block) apply(userId, true);
    },
  };
});

/** Заблокирован ли этот человек мной. */
export function useIsBlocked(userId: string | null | undefined): boolean {
  return useBlocksStore((s) => !!userId && s.ids.includes(userId));
}
