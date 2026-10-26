import { create } from "zustand";
import axios from "axios";
import {
  starsApi,
  type ChannelKind,
  type LayoutRoom,
  type RolePermissions,
  type RoomAccess,
  type RoomKind,
  type StarChannel,
  type StarDetail,
  type StarEvent,
  type StarKind,
  type StarLimits,
  type StarMember,
  type StarMessage,
  type StarRole,
  type StarAsset,
  type StarBooking,
  type StarSummary,
  type DoorSignKind,
  type WorkSchedule,
} from "../api/stars";
import { usersApi } from "../api/users";
import { notifyInfo } from "../notifications/notify";
import { socket } from "../ws/socket";
import { applyReaction } from "../chat/reactions";
import { useAuthStore } from "./auth";
import { useUiStore } from "./ui";

const ROLE_RANK: Record<StarRole, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };
const PAGE_SIZE = 50;

export function roleRank(role: StarRole): number {
  return ROLE_RANK[role];
}

/** Модератор и выше: без медленного режима и без обязательного согласия с правилами. */
export function isStaff(role: StarRole): boolean {
  return roleRank(role) >= ROLE_RANK.moderator;
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
  const { id, name, kind, owner_id, avatar_url, background_url, created_at, member_count, my_role } =
    detail;
  return { id, name, kind, owner_id, avatar_url, background_url, created_at, member_count, my_role };
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

/** Открытая ветка: корень и ответы по порядку (messages[0] — корень). */
export interface OpenThread {
  starId: string;
  channelId: string;
  rootId: string;
  messages: StarMessage[];
  loading: boolean;
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
  /** Стикеры, эмодзи и звуки Звёзд (грузятся при открытии Звезды). */
  assets: Record<string, StarAsset[]>;
  loadingMessages: boolean;
  unread: Record<string, Unread>;
  /** На телефоне канал открыт поверх списка. */
  mobileChannelOpen: boolean;
  notice: string | null;
  /** Окно «Вступить по приглашению»: null — закрыто. */
  joinDialog: { code: string } | null;
  thread: OpenThread | null;
  /** Брони переговорных на ближайшую неделю (грузятся, когда нужны). */
  bookings: Record<string, StarBooking[]>;
  /** Мой личный рабочий график (null — как в Звезде; undefined — ещё не загружен). */
  mySchedule: WorkSchedule | null | undefined;

  load: () => Promise<void>;
  /** Сверить список Звёзд с сервером (после обрыва связи, возвращения в приложение). */
  syncList: () => Promise<void>;
  refreshLimits: () => Promise<void>;
  selectStar: (starId: string) => Promise<void>;
  refreshStar: (starId: string) => Promise<void>;
  selectChannel: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (text: string, replyToId?: string, ackRequired?: boolean) => Promise<void>;
  openThread: (root: StarMessage) => Promise<void>;
  closeThread: () => void;
  sendThreadReply: (text: string) => Promise<void>;
  /** «Ознакомлен(а)» под объявлением. */
  ack: (message: StarMessage) => Promise<void>;
  setWorkHours: (enabled: boolean, schedule?: WorkSchedule) => Promise<void>;
  loadMySchedule: () => Promise<void>;
  setMySchedule: (schedule: WorkSchedule | null) => Promise<void>;
  loadBookings: (starId: string) => Promise<void>;
  book: (
    channelId: string,
    body: { title: string; starts_at: string; ends_at: string; attendees: string[] }
  ) => Promise<void>;
  cancelBooking: (booking: StarBooking) => Promise<void>;
  setDoorSign: (
    channelId: string,
    body: { kind: DoorSignKind | null; text?: string | null; until?: string | null }
  ) => Promise<void>;
  editMessage: (message: StarMessage, text: string) => Promise<void>;
  deleteMessage: (message: StarMessage) => Promise<void>;
  /** Поставить, сменить (emoji) или снять (null) свою реакцию. */
  react: (message: StarMessage, emoji: string | null) => Promise<void>;
  acceptRules: (starId: string) => Promise<void>;
  loadAssets: (starId: string) => Promise<void>;
  vote: (message: StarMessage, options: number[]) => Promise<void>;
  lfgAction: (message: StarMessage, action: "join" | "leave" | "start" | "cancel") => Promise<void>;
  createStar: (name: string, kind: StarKind) => Promise<void>;
  joinByCode: (code: string) => Promise<void>;
  createChannel: (body: {
    kind: ChannelKind;
    name: string;
    capacity?: number;
    room_kind?: RoomKind;
    access?: RoomAccess;
    cabinet_owner_id?: string;
    listen_only?: boolean;
    announcement?: boolean;
    floor_id?: string;
  }) => Promise<void>;
  updateChannel: (
    channelId: string,
    body: {
      name?: string;
      capacity?: number;
      room_kind?: RoomKind;
      access?: RoomAccess;
      cabinet_owner_id?: string;
      listen_only?: boolean;
      slow_mode_sec?: number;
      announcement?: boolean;
      floor_id?: string;
    }
  ) => Promise<void>;
  createFloor: (name: string) => Promise<string | null>;
  renameFloor: (floorId: string, name: string) => Promise<void>;
  deleteFloor: (floorId: string) => Promise<void>;
  saveLayout: (floorId: string, version: number, rooms: LayoutRoom[]) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  renameStar: (name: string) => Promise<void>;
  /** null — убрать аватар. */
  setStarAvatar: (file: Blob | null) => Promise<void>;
  /** null — убрать фон. */
  setStarBackground: (file: Blob | null) => Promise<void>;
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
  assets: {} as Record<string, StarAsset[]>,
  loadingMessages: false,
  unread: {} as Record<string, Unread>,
  mobileChannelOpen: false,
  notice: null,
  joinDialog: null,
  thread: null as OpenThread | null,
  bookings: {} as Record<string, StarBooking[]>,
  mySchedule: undefined as WorkSchedule | null | undefined,
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

  /** Звезды правда нет: сервер ответил «не участник» или «не найдена». */
  function isGone(err: unknown): boolean {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    return status === 403 || status === 404;
  }

  let lastSync = 0;
  let syncing: Promise<void> | null = null;

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
      const thread = s.thread?.starId === starId ? null : s.thread;
      return { details, unread, stars, activeStarId, mobileChannelOpen: false, thread };
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
      case "star_updated": {
        const patch = {
          name: event.name,
          owner_id: event.owner_id,
          avatar_url: event.avatar_url,
          background_url: event.background_url,
        };
        patchDetail(starId, (d) => ({ ...d, ...patch }));
        set((s) => ({
          stars: s.stars.map((st) => (st.id === starId ? { ...st, ...patch } : st)),
        }));
        break;
      }
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
        // Меня приняли в Звезду с другого устройства (или вкладки) — её ещё нет в списке.
        if (isMe && !get().stars.some((st) => st.id === starId)) {
          void get().syncList();
          break;
        }
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
        // Ответ в ветке — только в открытую ветку; сводку под корнем обновит star_thread.
        if (message.thread_id) {
          set((s) => {
            const thread = s.thread;
            if (!thread || thread.rootId !== message.thread_id || thread.messages.some((m) => m.id === message.id)) return {};
            return { thread: { ...thread, messages: [...thread.messages, message] } };
          });
          break;
        }
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
        if (get().thread?.rootId === event.message_id) set({ thread: null });
        // Ответы на удалённое остаются, но без цитаты — как после перезагрузки.
        patchMessages(event.channel_id, (list) =>
          list
            .filter((m) => m.id !== event.message_id)
            .map((m) => (m.reply_to?.id === event.message_id ? { ...m, reply_to: null } : m))
        );
        break;
      case "star_message_edited":
        patchMessages(event.channel_id, (list) =>
          list.map((m) => {
            if (m.id === event.message_id) return { ...m, text: event.text, edited_at: event.edited_at };
            if (m.reply_to?.id === event.message_id) return { ...m, reply_to: { ...m.reply_to, text: event.text } };
            return m;
          })
        );
        break;
      case "star_community":
        patchDetail(starId, (d) => ({
          ...d,
          rules_text: event.rules_text,
          // Правила поменялись — сервер сбросил согласие (кроме модераторов и выше).
          rules_accepted:
            event.rules_text === d.rules_text ? d.rules_accepted : !event.rules_text || isStaff(d.my_role),
          welcome_text: event.welcome_text,
          welcome_channel_id: event.welcome_channel_id,
          soundboard: event.soundboard,
        }));
        break;
      case "star_tags":
        patchDetail(starId, (d) => ({ ...d, tags: event.tags }));
        break;
      case "star_poll":
        patchMessages(event.channel_id, (list) =>
          list.map((m) =>
            m.id === event.message_id && m.poll
              ? { ...m, poll: { ...event.poll, my_votes: m.poll.my_votes } }
              : m
          )
        );
        break;
      case "star_lfg":
        patchMessages(event.channel_id, (list) =>
          list.map((m) => (m.id === event.message_id ? { ...m, lfg: event.lfg } : m))
        );
        break;
      case "star_assets":
        if (get().assets[starId]) void get().loadAssets(starId);
        break;
      case "star_thread":
        patchMessages(event.channel_id, (list) =>
          list.map((m) =>
            m.id === event.root_id
              ? {
                  ...m,
                  thread_count: event.count,
                  thread_last_at: event.last_at,
                  thread_participants: event.participants,
                }
              : m
          )
        );
        break;
      case "star_ack":
        patchMessages(event.channel_id, (list) =>
          list.map((m) => (m.id === event.message_id ? { ...m, ack_count: event.ack_count } : m))
        );
        break;
      case "star_work_hours":
        patchDetail(starId, (d) => ({
          ...d,
          work_hours_enabled: event.enabled,
          work_hours: event.schedule,
        }));
        break;
      case "star_bookings":
        if (get().bookings[starId]) void get().loadBookings(starId);
        break;
      case "star_booking_soon": {
        const at = new Date(event.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
        // Бронь могли сделать на «уже сейчас» или за пару минут до начала.
        const minutes = Math.round((Date.parse(event.starts_at) - Date.now()) / 60_000);
        const when = minutes > 0 ? `Через ${minutes} мин` : "Уже идёт";
        notifyInfo({ title: `📅 ${when}: «${event.title}»`, body: `${event.room ?? "Переговорная"} · в ${at}` });
        break;
      }
      case "star_message_reaction":
        patchMessages(event.channel_id, (list) =>
          list.map((m) =>
            m.id === event.message_id
              ? {
                  ...m,
                  reactions: applyReaction(
                    m.reactions,
                    event.user_id,
                    event.emoji === null ? null : { user_id: event.user_id, emoji: event.emoji }
                  ),
                }
              : m
          )
        );
        break;
    }
  }

  /** Изменить загруженные сообщения Спутника (не открывали — нечего менять) и открытую ветку в нём. */
  function patchMessages(channelId: string, fn: (list: StarMessage[]) => StarMessage[]) {
    set((s) => {
      const list = s.messages[channelId];
      const patch: Partial<StarsState> = {};
      if (list) patch.messages = { ...s.messages, [channelId]: fn(list) };
      if (s.thread?.channelId === channelId) patch.thread = { ...s.thread, messages: fn(s.thread.messages) };
      return patch;
    });
  }

  socket.on((event) => {
    if (event.type.startsWith("star_")) handleEvent(event as StarEvent);
    else if (event.type === "my_work_schedule") set({ mySchedule: event.schedule });
  });

  // Связь вернулась (проснулся телефон, перезапустился сервер) — сверяем список: пока её не
  // было, могли принять в Звезду или выгнать.
  socket.onStatus((open) => {
    if (open && get().loaded) void get().syncList();
  });

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && get().loaded && Date.now() - lastSync > 30_000) {
        void get().syncList();
      }
    });
  }

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
      lastSync = Date.now();
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

    syncList: async () => {
      syncing ??= (async () => {
        try {
          const stars = await starsApi.list();
          lastSync = Date.now();
          const present = new Set(stars.map((st) => st.id));
          for (const st of get().stars) {
            if (!present.has(st.id)) forgetStar(st.id);
          }
          // Порядок и данные — как на сервере; карточки уже открытых Звёзд не трогаем.
          set((s) => ({
            stars: stars.map((st) => (s.details[st.id] ? summaryOf(s.details[st.id]) : st)),
          }));
          const { activeStarId } = get();
          if (!activeStarId && stars[0]) await get().selectStar(stars[0].id);
          // Открытая Звезда не загрузилась (была без связи) — пробуем снова.
          else if (activeStarId && !get().details[activeStarId]) await get().refreshStar(activeStarId);
        } catch {
          // Нет связи — сверимся при следующем подключении.
        } finally {
          syncing = null;
        }
      })();
      return syncing;
    },

    refreshStar: async (starId) => {
      try {
        adoptDetail(await starsApi.get(starId));
      } catch (err) {
        // Убираем Звезду из списка, только если её правда нет. Сбой сети или перезапуск
        // сервера — не повод: иначе она пропадёт до перезапуска приложения.
        if (isGone(err)) forgetStar(starId);
        else set({ notice: "Не удалось загрузить Звезду — проверьте интернет. Попробуем снова." });
      }
    },

    selectChannel: async (channelId) => {
      const starId = get().activeStarId;
      if (!starId) return;
      set((s) => {
        const unread = { ...s.unread };
        delete unread[channelId];
        // Ветка — часть своего Спутника: ушли в другой канал — закрываем.
        const thread = s.thread?.channelId === channelId ? s.thread : null;
        return { activeChannelByStar: { ...s.activeChannelByStar, [starId]: channelId }, unread, thread };
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

    sendMessage: async (text, replyToId, ackRequired) => {
      const starId = get().activeStarId;
      const channelId = activeChannelId();
      if (!starId || !channelId) return;
      const message = await starsApi.send(
        starId,
        channelId,
        text,
        replyToId,
        ackRequired ? { ack_required: true } : {}
      );
      handleEvent({ type: "star_message", star_id: starId, message });
    },

    openThread: async (root) => {
      const target = root.thread_id ?? root.id;
      if (get().thread?.rootId === target) return;
      set({
        thread: {
          starId: root.star_id,
          channelId: root.channel_id,
          rootId: target,
          messages: target === root.id ? [root] : [],
          loading: true,
        },
      });
      try {
        const loaded = await starsApi.thread(root.star_id, root.channel_id, target);
        set((s) => {
          if (s.thread?.rootId !== target) return {};
          // Пока грузили, могли прийти новые ответы — их не теряем.
          const known = new Set(loaded.map((m) => m.id));
          const fresh = s.thread.messages.filter((m) => !known.has(m.id) && m.id !== target);
          return { thread: { ...s.thread, messages: [...loaded, ...fresh], loading: false } };
        });
      } catch (err) {
        set((s) => (s.thread?.rootId === target ? { thread: null } : {}));
        throw err;
      }
    },

    closeThread: () => set({ thread: null }),

    sendThreadReply: async (text) => {
      const thread = get().thread;
      if (!thread) return;
      const message = await starsApi.send(thread.starId, thread.channelId, text, undefined, {
        thread_id: thread.rootId,
      });
      handleEvent({ type: "star_message", star_id: thread.starId, message });
    },

    ack: async (message) => {
      // Число — с сервера: событие star_ack могло прийти раньше ответа, прибавлять нельзя.
      const { ack_count } = await starsApi.ack(message.star_id, message.id);
      patchMessages(message.channel_id, (list) =>
        list.map((m) => (m.id === message.id ? { ...m, acked: true, ack_count } : m))
      );
    },

    setWorkHours: async (enabled, schedule) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.setWorkHours(starId, enabled, schedule);
      patchDetail(starId, (d) => ({
        ...d,
        work_hours_enabled: enabled,
        work_hours: schedule ?? d.work_hours ?? null,
      }));
    },

    loadMySchedule: async () => {
      set({ mySchedule: await usersApi.workSchedule() });
    },

    setMySchedule: async (schedule) => {
      await usersApi.setWorkSchedule(schedule);
      set({ mySchedule: schedule });
    },

    loadBookings: async (starId) => {
      const list = await starsApi.bookings(starId);
      set((s) => ({ bookings: { ...s.bookings, [starId]: list } }));
    },

    book: async (channelId, body) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.book(starId, channelId, body);
      await get().loadBookings(starId);
    },

    cancelBooking: async (booking) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.cancelBooking(starId, booking.id);
      set((s) => ({
        bookings: {
          ...s.bookings,
          [starId]: (s.bookings[starId] ?? []).filter((b) => b.id !== booking.id),
        },
      }));
    },

    setDoorSign: async (channelId, body) => {
      const starId = get().activeStarId;
      if (!starId) return;
      await starsApi.doorSign(starId, channelId, body);
    },

    editMessage: async (message, text) => {
      const out = await starsApi.editMessage(message.star_id, message.channel_id, message.id, text);
      handleEvent({
        type: "star_message_edited",
        star_id: message.star_id,
        channel_id: message.channel_id,
        message_id: message.id,
        text: out.text,
        edited_at: out.edited_at ?? new Date().toISOString(),
      });
    },

    acceptRules: async (starId) => {
      await starsApi.acceptRules(starId);
      patchDetail(starId, (d) => ({ ...d, rules_accepted: true }));
    },

    loadAssets: async (starId) => {
      const assets = await starsApi.assets(starId);
      set((s) => ({ assets: { ...s.assets, [starId]: assets } }));
    },

    vote: async (message, options) => {
      if (!message.poll) return;
      const poll = await starsApi.vote(message.star_id, message.poll.id, options);
      patchMessages(message.channel_id, (list) => list.map((m) => (m.id === message.id ? { ...m, poll } : m)));
    },

    lfgAction: async (message, action) => {
      if (!message.lfg) return;
      const lfg = await starsApi.lfgAction(message.star_id, message.lfg.id, action);
      patchMessages(message.channel_id, (list) => list.map((m) => (m.id === message.id ? { ...m, lfg } : m)));
    },

    react: async (message, emoji) => {
      const me = myId();
      if (!me) return;
      if (emoji === null) await starsApi.unreact(message.star_id, message.channel_id, message.id);
      else await starsApi.react(message.star_id, message.channel_id, message.id, emoji);
      handleEvent({
        type: "star_message_reaction",
        star_id: message.star_id,
        channel_id: message.channel_id,
        message_id: message.id,
        user_id: me,
        emoji,
      });
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

    setStarAvatar: async (file) => {
      const starId = get().activeStarId;
      if (!starId) return;
      adoptDetail(
        await (file ? starsApi.uploadAvatar(starId, file) : starsApi.removeAvatar(starId))
      );
    },

    setStarBackground: async (file) => {
      const starId = get().activeStarId;
      if (!starId) return;
      adoptDetail(
        await (file ? starsApi.uploadBackground(starId, file) : starsApi.removeBackground(starId))
      );
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
