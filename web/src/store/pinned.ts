import { create } from "zustand";
import { pinnedApi, type PinKind, type Pinned } from "../api/pinned";
import { apiErrorText } from "../utils/profile";
import { socket } from "../ws/socket";
import { useUiStore } from "./ui";

/** Старое «Избранное» хранилось только в этом браузере — один раз переносим его в закреплённые. */
function takeLegacyFavorites(): string[] {
  const ids = useUiStore.getState().favoriteChatIds;
  if (ids.length) useUiStore.setState({ favoriteChatIds: [] });
  return ids;
}

interface PinnedState {
  pinned: Pinned | null;
  load: () => Promise<void>;
  /** Закрепить или открепить. Возвращает текст ошибки (например, лимит) или null. */
  toggle: (kind: PinKind, id: string) => Promise<string | null>;
  reset: () => void;
}

export const usePinnedStore = create<PinnedState>((set, get) => {
  const apply = (next: Pinned) => {
    const current = get().pinned;
    if (!current || next.rev >= current.rev) set({ pinned: next });
  };
  socket.on((event) => {
    if (event.type === "pins_changed") apply(event.pins);
  });

  return {
    pinned: null,

    load: async () => {
      let pinned = await pinnedApi.list();
      const legacy = takeLegacyFavorites();
      // Если на аккаунте ещё ничего не закреплено — берём избранные этого браузера (сколько влезет).
      if (legacy.length && !pinned.chats.length) {
        for (const id of legacy.slice(0, pinned.limit).reverse()) {
          pinned = await pinnedApi.pin("chats", id).catch(() => pinned);
        }
      }
      set({ pinned });
    },

    toggle: async (kind, id) => {
      const current = get().pinned;
      const on = !!current?.[kind].includes(id);
      try {
        apply(on ? await pinnedApi.unpin(kind, id) : await pinnedApi.pin(kind, id));
        return null;
      } catch (err) {
        return apiErrorText(err, "Не получилось закрепить");
      }
    },

    reset: () => set({ pinned: null }),
  };
});

