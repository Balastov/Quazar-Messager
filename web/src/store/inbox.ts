import { create } from "zustand";
import { inboxApi, type InboxItem } from "../api/inbox";
import { notifyInbox } from "../notifications/notify";
import { socket } from "../ws/socket";
import { useStarsStore } from "./stars";

const PAGE = 30;

interface InboxState {
  items: InboxItem[];
  unread: number;
  loaded: boolean;
  hasMore: boolean;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Открыть: отметить прочитанным и перейти в комнату брони. */
  open: (item: InboxItem) => Promise<void>;
  /** Из push/системного уведомления или всплывашки: известны только id и куда вести. */
  openLink: (link: { notificationId?: string | null; starId?: string | null; channelId?: string | null }) => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  reset: () => void;
}

export const useInboxStore = create<InboxState>((set, get) => {
  let revision = 0;
  const readLocally = (ids: string[] | null) => {
    const at = new Date().toISOString();
    set((s) => ({
      items: s.items.map((i) => (!i.read_at && (ids === null || ids.includes(i.id)) ? { ...i, read_at: at } : i)),
    }));
  };

  socket.on((event) => {
    if (event.type === "inbox_new") {
      const item = event.notification;
      set((s) => ({
        items: s.items.some((i) => i.id === item.id) ? s.items : [item, ...s.items],
        unread: event.unread,
      }));
      void notifyInbox({ id: item.id, title: item.title, body: item.body, starId: item.data.star_id, channelId: item.data.channel_id });
    } else if (event.type === "inbox_read") {
      readLocally(event.ids);
      set({ unread: event.unread });
    }
  });
  // После входа и после обрыва связи — свежий список (пока не было связи, могло прийти новое).
  socket.onStatus((open) => {
    if (open) void get().load().catch(() => {});
  });

  return {
    items: [],
    unread: 0,
    loaded: false,
    hasMore: false,

    load: async () => {
      const mine = ++revision;
      const page = await inboxApi.list();
      if (mine !== revision) return;
      set({ items: page.items, unread: page.unread, loaded: true, hasMore: page.items.length >= PAGE });
    },

    loadMore: async () => {
      const last = get().items[get().items.length - 1];
      if (!last || !get().hasMore) return;
      const mine = revision;
      const page = await inboxApi.list(last.created_at);
      if (mine !== revision) return;
      set((s) => ({
        items: [...s.items, ...page.items.filter((i) => !s.items.some((x) => x.id === i.id))],
        unread: page.unread,
        hasMore: page.items.length >= PAGE,
      }));
    },

    markRead: async (id) => {
      const item = get().items.find((i) => i.id === id);
      if (item && !item.read_at) {
        readLocally([id]);
        set((s) => ({ unread: Math.max(0, s.unread - 1) }));
      }
      try {
        const { unread } = await inboxApi.read(id);
        set({ unread });
      } catch {
        // Уже удалено или нет связи — счётчик поправит следующая загрузка.
      }
    },

    markAllRead: async () => {
      readLocally(null);
      set({ unread: 0 });
      const { unread } = await inboxApi.readAll();
      set({ unread });
    },

    open: async (item) => {
      void get().markRead(item.id);
      const { star_id, channel_id } = item.data;
      if (star_id && channel_id) await useStarsStore.getState().openChannelLink(star_id, channel_id);
    },

    openLink: async ({ notificationId, starId, channelId }) => {
      if (notificationId) void get().markRead(notificationId);
      if (starId && channelId) await useStarsStore.getState().openChannelLink(starId, channelId);
    },

    reset: () => {
      revision++;
      set({ items: [], unread: 0, loaded: false, hasMore: false });
    },
  };
});
