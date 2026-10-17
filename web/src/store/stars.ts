import { create } from "zustand";
import {
  starsApi,
  type ChannelKind,
  type LayoutRoom,
  type RolePermissions,
  type RoomKind,
  type StarChannel,
  type StarDetail,
  type StarEvent,
  type StarKind,
  type StarLimits,
  type StarMember,
  type StarMessage,
  type StarRole,
  type StarSummary,
} from "../api/stars";
import { socket } from "../ws/socket";
import { useAuthStore } from "./auth";
import { useUiStore } from "./ui";

const ROLE_RANK: Record<StarRole, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };
const PAGE_SIZE = 50;

export function roleRank(role: StarRole): number {
  return ROLE_RANK[role];
}

export function sortChannels(channels: StarChannel[]): StarChannel[] {
  return [...channels].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "satellite" ? -1 : 1;
    return a.position - b.position;
  });
}

function sortMembers(members: StarMember[]): StarMember[] {
  return [...members].sort(
    (a, b) => roleRank(b.role) - roleRank(a.role) || a.joined_at.localeCompare(b.joined_at)
  );
}

function summaryOf(detail: StarDetail): StarSummary {
  const { id, name, kind, owner_id, created_at, member_count, my_role } = detail;
  return { id, name, kind, owner_id, created_at, member_count, my_role };
}

function firstSatellite(detail: StarDetail | undefined): string | null {
  return sortChannels(detail?.channels ?? []).find((c) => c.kind === "satellite")?.id ?? null;
}

const REMOVED_NOTICE: Record<string, (name: string) => string> = {
  kick: (n) => `Вас исключили из Звезды «${n}»`,
  ban: (n) => `Вас заблокировали в Звезде «${n}»`,
  deleted: (n) => `Звезда «${n}» удалена`,
};

interface Unread {
  starId: string;
  count: number;
}

interface StarsState {
  loaded: boolean;
  stars: StarSummary[];
  limits: StarLimits | null;
  details: Record<string, StarDetail>;
  activeStarId: string | null;
  /** Последний открытый канал в каждой Звезде. */
  activeChannelByStar: Record<string, string | null>;
  messages: Record<string, StarMessage[]>;
  hasMore: Record<string, boolean>;
  loadingMessages: boolean;
  unread: Record<string, Unread>;
  /** На телефоне канал открыт поверх списка. */
  mobileChannelOpen: boolean;
  notice: string | null;
  /** Окно «Вступить по приглашению»: null — закрыто. */
  joinDialog: { code: string } | null;

  load: () => Promise<void>;
  refreshLimits: () => Promise<void>;
  selectStar: (starId: string) => Promise<void>;
  refreshStar: (starId: string) => Promise<void>;
  selectChannel: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  deleteMessage: (message: StarMessage) => Promise<void>;
  createStar: (name: string, kind: StarKind) => Promise<void>;
  joinByCode: (code: string) => Promise<void>;
  createChannel: (body: {
    kind: ChannelKind;
    name: string;
    capacity?: number;
    room_kind?: RoomKind;
    floor_id?: string;
  }) => Promise<void>;
  updateChannel: (
    channelId: string,
    body: { name?: string; capacity?: number; room_kind?: RoomKind; floor_id?: string }
  ) => Promise<void>;
  createFloor: (name: string) => Promise<string | null>;
  renameFloor: (floorId: string, name: string) => Promise<void>;
  deleteFloor: (floorId: string) => Promise<void>;
  saveLayout: (floorId: string, version: number, rooms: LayoutRoom[]) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  renameStar: (name: string) => Promise<void>;
  deleteStar: () => Promise<void>;
  transferStar: (userId: string) => Promise<void>;
  leaveStar: () => Promise<void>;
  setRole: (userId: string, role: Exclude<StarRole, "owner">) => Promise<void>;
  kick: (userId: string) => Promise<void>;
  ban: (userId: string) => Promise<void>;
  setPermissions: (perms: RolePermissions) => Promise<void>;
  setMobileChannelOpen: (open: boolean) => void;
  openJoinDialog: (code?: string) => void;
  closeJoinDialog: () => void;
  dismissNotice: () => void;
  reset: () => void;
}

const initialState = {
  loaded: false,
  stars: [] as StarSummary[],
  limits: null,
  details: {} as Record<string, StarDetail>,
  activeStarId: null,
  activeChannelByStar: {} as Record<string, string | null>,
  messages: {} as Record<string, StarMessage[]>,
  hasMore: {} as Record<string, boolean>,
  loadingMessages: false,
  unread: {} as Record<string, Unread>,
  mobileChannelOpen: false,
  notice: null,
  joinDialog: null,
};

export const useStarsStore = create<StarsState>((set, get) => {
  const myId = () => useAuthStore.getState().user?.id ?? null;

  function activeChannelId(): string | null {
    const { activeStarId, activeChannelByStar } = get();
    return activeStarId ? (activeChannelByStar[activeStarId] ?? null) : null;
  }

  function patchDetail(starId: string, patch: (d: StarDetail) => StarDetail) {
    const detail = get().details[starId];
    if (!detail) return;
    const next = patch(detail);
    set((s) => ({
      details: { ...s.details, [starId]: next },
      stars: s.stars.map((st) => (st.id === starId ? summaryOf(next) : st)),
    }));
  }

  /** Добавляет Звезду в список и делает активной. */
  function adoptDetail(detail: StarDetail) {
    set((s) => ({
      stars: s.stars.some((st) => st.id === detail.id)
        ? s.stars.map((st) => (st.id === detail.id ? summaryOf(detail) : st))
        : [...s.stars, summaryOf(detail)],
      details: { ...s.details, [detail.id]: detail },
    }));
  }

  function forgetStar(starId: string) {
    set((s) => {
      const details = { ...s.details };
      delete details[starId];
      const channelIds = new Set(
        Object.entries(s.unread)
          .filter(([, u]) => u.starId === starId)
          .map(([id]) => id)
      );
      const unread = Object.fromEntries(
        Object.entries(s.unread).filter(([id]) => !channelIds.has(id))
      );
      const stars = s.stars.filter((st) => st.id !== starId);
      const activeStarId = s.activeStarId === starId ? (stars[0]?.id ?? null) : s.activeStarId;
      return { details, unread, stars, activeStarId, mobileChannelOpen: false };
    });
    const nextActive = get().activeStarId;
    if (nextActive && !get().details[nextActive]) void get().refreshStar(nextActive);
  }

  function handleEvent(event: StarEvent) {
    const { star_id: starId } = event;
    switch (event.type) {
      case "star_removed": {
        const name = get().stars.find((s) => s.id === starId)?.name ?? "";
        const notice = REMOVED_NOTICE[event.reason]?.(name) ?? null;
        forgetStar(starId);
        if (notice) set({ notice });
        void get().refreshLimits();
        break;
      }
      case "star_updated":
        patchDetail(starId, (d) => ({ ...d, name: event.name, owner_id: event.owner_id }));
        set((s) => ({
          stars: s.stars.map((st) =>
            st.id === starId ? { ...st, name: event.name, owner_id: event.owner_id } : st
          ),
        }));
        break;
      case "star_member_upsert": {
        const isMe = event.member.user.id === myId();
        patchDetail(starId, (d) => {
          const others = d.members.filter((m) => m.user.id !== event.member.user.id);
          const members = sortMembers([...others, event.member]);
          return {
            ...d,
            members,
            member_count: members.length,
            my_role: isMe ? event.member.role : d.my_role,
          };
        });
        // Моя роль изменилась — права пересчитает сервер.
        if (isMe) {
          void get().refreshStar(starId);
          void get().refreshLimits();
        }
        break;
      }
      case "star_member_removed":
        patchDetail(starId, (d) => {
          const members = d.members.filter((m) => m.user.id !== event.user_id);
          return { ...d, members, member_count: members.length };
        });
        break;
      case "star_permissions":
        void get().refreshStar(starId);
        break;
      case "star_channel_upsert":
        patchDetail(starId, (d) => ({
          ...d,
          channels: sortChannels([
            ...d.channels.filter((c) => c.id !== event.channel.id),
            event.channel,
          ]),
        }));
        break;
      case "star_channel_deleted": {
        patchDetail(starId, (d) => ({
          ...d,
          channels: d.channels.filter((c) => c.id !== event.channel_id),
        }));
        set((s) => {
          const messages = { ...s.messages };
          delete messages[event.channel_id];
          const unread = { ...s.unread };
          delete unread[event.channel_id];
          const activeChannelByStar = { ...s.activeChannelByStar };
          if (activeChannelByStar[starId] === event.channel_id) {
            activeChannelByStar[starId] = firstSatellite(s.details[starId]);
          }
          return { messages, unread, activeChannelByStar };
        });
        break;
      }
      case "star_channels_order":
        patchDetail(starId, (d) => {
          const order = new Map(event.channel_ids.map((id, i) => [id, i]));
          return {
            ...d,
            channels: sortChannels(
              d.channels.map((c) => ({ ...c, position: order.get(c.id) ?? c.position }))
            ),
          };
        });
        break;
      case "star_message": {
        const { message } = event;
        set((s) => {
          const list = s.messages[message.channel_id];
          if (!list || list.some((m) => m.id === message.id)) return {};
          return { messages: { ...s.messages, [message.channel_id]: [...list, message] } };
        });
        const viewing =
          useUiStore.getState().tab === "stars" &&
          activeChannelId() === message.channel_id &&
          document.visibilityState === "visible";
        if (message.sender?.id !== myId() && !viewing) {
          set((s) => ({
            unread: {
              ...s.unread,
              [message.channel_id]: {
                starId,
                count: (s.unread[message.channel_id]?.count ?? 0) + 1,
              },
            },
          }));
        }
        break;
      }
      case "star_floors":
        patchDetail(starId, (d) => ({
          ...d,
          floors: [...event.floors].sort((a, b) => a.position - b.position),
        }));
        break;
      case "star_layout":
        patchDetail(starId, (d) => {
          const rooms = new Map(event.rooms.map((r) => [r.channel_id, r]));
          return {
            ...d,
            floors: d.floors.map((f) => (f.id === event.floor.id ? event.floor : f)),
            channels: d.channels.map((c) => {
              const r = rooms.get(c.id);
              return r ? { ...c, map_x: r.x, map_y: r.y, map_w: r.w, map_h: r.h } : c;
            }),
          };
        });
        break;
      case "star_voice":
        patchDetail(starId, (d) => {
          const voice = { ...(d.voice ?? {}) };
          if (event.participants.length) voice[event.channel_id] = event.participants;
          else delete voice[event.channel_id];
          return { ...d, voice };
        });
        break;
      case "star_message_deleted":
        set((s) => {
          const list = s.messages[event.channel_id];
          if (!list) return {};
          return {
            messages: {
              ...s.messages,
              [event.channel_id]: list.filter((m) => m.id !== event.message_id),
            },
          };
        });
        break;
    }
  }

  socket.on((event) => {
    if (event.type.startsWith("star_")) handleEvent(event as StarEvent);
  });

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (useUiStore.getState().tab !== "stars") return;
      const channelId = activeChannelId();
      if (channelId && get().unread[channelId]) {
        set((s) => {
          const unread = { ...s.unread };
          delete unread[channelId];
          return { unread };
        });
      }
    });
  }

  return {
    ...initialState,

    load: async () => {
      const [stars, limits] = await Promise.all([starsApi.list(), starsApi.limits()]);
      set({ stars, limits, loaded: true });
      const { activeStarId } = get();
      const target =
        activeStarId && stars.some((s) => s.id === activeStarId) ? activeStarId : stars[0]?.id;
      if (target) await get().selectStar(target);
    },

    refreshLimits: async () => {
      try {
        set({ limits: await starsApi.limits() });
      } catch {
        // ignore
      }
    },

    selectStar: async (starId) => {
      set({ activeStarId: starId });
      if (!get().details[starId]) {
        await get().refreshStar(starId);
      }
      const detail = get().details[starId];
      const remembered = get().activeChannelByStar[starId];
      const channelId =
        remembered && detail?.channels.some((c) => c.id === remembered)
          ? remembered
          : firstSatellite(detail);
      if (channelId) await get().selectChannel(channelId);
    },

    refreshStar: async (starId) => {
      try {
        adoptDetail(await starsApi.get(starId));
      } catch {
        forgetStar(starId);
      }
    },

    selectChannel: async (channelId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      set((s) => {
        const unread = { ...s.unread };
        delete unread[channelId];
        return { activeChannelByStar: { ...s.activeChannelByStar, [starId]: channelId }, unread };
      });

      const channel = get().details[starId]?.channels.find((c) => c.id === channelId);
      if (channel?.kind !== "satellite" || get().messages[channelId]) return;

      set({ loadingMessages: true });
      try {
        const page = await starsApi.messages(starId, channelId);
        set((s) => ({
          messages: { ...s.messages, [channelId]: page },
          hasMore: { ...s.hasMore, [channelId]: page.length >= PAGE_SIZE },
        }));
      } finally {
        set({ loadingMessages: false });
      }
    },

    loadOlder: async (channelId) => {
      const starId = get().activeStarId;
      const list = get().messages[channelId];
      if (!starId || !list?.length || !get().hasMore[channelId]) return;
      const page = await starsApi.messages(starId, channelId, list[0].id);
      set((s) => ({
        messages: { ...s.messages, [channelId]: [...page, ...(s.messages[channelId] ?? [])] },
        hasMore: { ...s.hasMore, [channelId]: page.length >= PAGE_SIZE },
      }));
    },

    sendMessage: async (text) => {
      const starId = get().activeStarId;
      const channelId = activeChannelId();
      if (!starId || !channelId) return;
      const message = await starsApi.send(starId, channelId, text);
      handleEvent({ type: "star_message", star_id: starId, message });
    },

    deleteMessage: async (message) => {
      await starsApi.deleteMessage(message.star_id, message.channel_id, message.id);
      handleEvent({
        type: "star_message_deleted",
        star_id: message.star_id,
        channel_id: message.channel_id,
        message_id: message.id,
      });
    },

    createStar: async (name, kind) => {
      const detail = await starsApi.create(name, kind);
      adoptDetail(detail);
      void get().refreshLimits();
      await get().selectStar(detail.id);
    },

    joinByCode: async (code) => {
      const detail = await starsApi.joinInvite(code);
      adoptDetail(detail);
      set({ joinDialog: null });
      await get().selectStar(detail.id);
    },

    createChannel: async (body) => {
      const starId = get().activeStarId;
      if (!starId) return;
      const channel = await starsApi.createChannel(starId, body);
      handleEvent({ type: "star_channel_upsert", star_id: starId, channel });
      if (channel.kind === "satellite") await get().selectChannel(channel.id);
    },

    updateChannel: async (channelId, body) => {
      const starId = get().activeStarId;
      if (!starId) return;
      const channel = await starsApi.updateChannel(starId, channelId, body);
      handleEvent({ type: "star_channel_upsert", star_id: starId, channel });
    },

    deleteChannel: async (channelId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.deleteChannel(starId, channelId);
      handleEvent({ type: "star_channel_deleted", star_id: starId, channel_id: channelId });
    },

    createFloor: async (name) => {
      const starId = get().activeStarId;
      if (!starId) return null;
      const floor = await starsApi.createFloor(starId, name);
      patchDetail(starId, (d) =>
        d.floors.some((f) => f.id === floor.id) ? d : { ...d, floors: [...d.floors, floor] }
      );
      return floor.id;
    },

    renameFloor: async (floorId, name) => {
      const starId = get().activeStarId;
      if (!starId) return;
      const floor = await starsApi.renameFloor(starId, floorId, name);
      patchDetail(starId, (d) => ({
        ...d,
        floors: d.floors.map((f) => (f.id === floor.id ? floor : f)),
      }));
    },

    deleteFloor: async (floorId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.deleteFloor(starId, floorId);
      // Комнаты переехали на другой этаж — берём свежие данные.
      await get().refreshStar(starId);
    },

    saveLayout: async (floorId, version, rooms) => {
      const starId = get().activeStarId;
      if (!starId) return;
      const out = await starsApi.saveLayout(starId, floorId, version, rooms);
      handleEvent({ type: "star_layout", star_id: starId, ...out });
    },

    renameStar: async (name) => {
      const starId = get().activeStarId;
      if (!starId) return;
      adoptDetail(await starsApi.rename(starId, name));
    },

    deleteStar: async () => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.remove(starId);
      forgetStar(starId);
      void get().refreshLimits();
    },

    transferStar: async (userId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      adoptDetail(await starsApi.transfer(starId, userId));
      void get().refreshLimits();
    },

    leaveStar: async () => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.leave(starId);
      forgetStar(starId);
    },

    setRole: async (userId, role) => {
      const starId = get().activeStarId;
      if (!starId) return;
      const member = await starsApi.setRole(starId, userId, role);
      handleEvent({ type: "star_member_upsert", star_id: starId, member });
    },

    kick: async (userId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.kick(starId, userId);
      handleEvent({ type: "star_member_removed", star_id: starId, user_id: userId, reason: "kick" });
    },

    ban: async (userId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.ban(starId, userId);
      handleEvent({ type: "star_member_removed", star_id: starId, user_id: userId, reason: "ban" });
    },

    setPermissions: async (perms) => {
      const starId = get().activeStarId;
      if (!starId) return;
      const rolePermissions = await starsApi.setPermissions(starId, perms);
      patchDetail(starId, (d) => ({ ...d, role_permissions: rolePermissions }));
    },

    setMobileChannelOpen: (open) => set({ mobileChannelOpen: open }),
    openJoinDialog: (code = "") => set({ joinDialog: { code } }),
    closeJoinDialog: () => set({ joinDialog: null }),
    dismissNotice: () => set({ notice: null }),
    reset: () => set(initialState),
  };
});

/** Непрочитанное по Звезде — для значка в столбике Звёзд. */
export function unreadForStar(unread: Record<string, Unread>, starId: string): number {
  let total = 0;
  for (const u of Object.values(unread)) if (u.starId === starId) total += u.count;
  return total;
}
