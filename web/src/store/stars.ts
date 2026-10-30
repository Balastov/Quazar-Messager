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
  type ScheduledStarMessage,
  type StarRole,
  type StarAsset,
  type StarBooking,
  type StarBookmark,
  type StarSummary,
  type DoorSignKind,
  type WorkSchedule,
} from "../api/stars";
import { usersApi } from "../api/users";
import { notifyInfo, notifyStarMessage } from "../notifications/notify";
import { channelLevel, useNotifyStore, wants } from "../notifications/levels";
import { memberWorkState } from "../chat/workhours";
import type { LinkPreview } from "../chat/linkPreview";
import { socket } from "../ws/socket";
import { applyReaction } from "../chat/reactions";
import { useAuthStore } from "./auth";
import { useUiStore } from "./ui";
import { compareUsers, displayName } from "../utils/profile";
import { stripMarkup } from "../chat/markdown";

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
  return [...members].sort((a, b) => compareUsers(a.user, b.user));
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
  /** Из них — упоминаний меня и ответов мне. */
  mentions?: number;
}

/** Что открыто в Звезде: карта офиса, раздел «Файлы» или канал. */
export type StarView = "map" | "files" | "channel";

/** Меня упомянули (@имя, @все) или ответили мне. */
export function mentionsMe(message: StarMessage, myId: string | null | undefined): boolean {
  if (!myId || message.sender?.id === myId) return false;
  return !!message.mention_all || !!message.mentions?.includes(myId) || message.reply_to?.sender?.id === myId;
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
  scheduled: Record<string, ScheduledStarMessage[]>;
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
  /** Что открыто в каждой Звезде; нет записи — по умолчанию (у рабочих — карта). */
  viewByStar: Record<string, StarView>;
  /** Закреплённые в Спутнике (свежие первыми); нет записи — не загружали. */
  pins: Record<string, StarMessage[]>;
  /** Закладки Спутника по порядку полосы; нет записи — не загружали. */
  bookmarks: Record<string, StarBookmark[]>;
  /** Прокрутить Спутник к сообщению (из поиска или закрепа). */
  revealRequest: { channelId: string; messageId: string } | null;

  load: () => Promise<void>;
  /** Сверить список Звёзд с сервером (после обрыва связи, возвращения в приложение). */
  syncList: () => Promise<void>;
  refreshLimits: () => Promise<void>;
  selectStar: (starId: string) => Promise<void>;
  refreshStar: (starId: string) => Promise<void>;
  selectChannel: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (text: string, replyToId?: string, ackRequired?: boolean, linkPreview?: LinkPreview | null) => Promise<void>;
  loadScheduled: (starId: string, channelId: string) => Promise<void>;
  scheduleMessage: (
    starId: string, channelId: string, text: string, at: Date,
    extra?: { reply_to_id?: string; ack_required?: boolean; link_preview?: LinkPreview }
  ) => Promise<void>;
  cancelScheduled: (starId: string, channelId: string, id: string) => Promise<void>;
  loadPins: (starId: string, channelId: string) => Promise<void>;
  loadBookmarks: (starId: string, channelId: string) => Promise<void>;
  pinMessage: (message: StarMessage, pinned: boolean) => Promise<void>;
  /** Открыть Спутник (или ветку) и прокрутить к сообщению; догружает историю. */
  jumpTo: (message: Pick<StarMessage, "id" | "star_id" | "channel_id" | "thread_id">) => Promise<void>;
  clearReveal: () => void;
  /** Файл в открытый Спутник (или в открытую ветку). onProgress — доля загрузки 0…1. */
  sendFile: (file: File, opts?: { caption?: string; inThread?: boolean; onProgress?: (share: number) => void }) => Promise<void>;
  setView: (starId: string, view: StarView) => void;
  /** Из уведомления: открыть Звезду на этом Спутнике. */
  openChannelLink: (starId: string, channelId: string) => Promise<void>;
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
  scheduled: {} as Record<string, ScheduledStarMessage[]>,
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
  viewByStar: {} as Record<string, StarView>,
  pins: {} as Record<string, StarMessage[]>,
  bookmarks: {} as Record<string, StarBookmark[]>,
  revealRequest: null as { channelId: string; messageId: string } | null,
};

export const useStarsStore = create<StarsState>((set, get) => {
  const myId = () => useAuthStore.getState().user?.id ?? null;
  let scheduledRevision = 0;
  const scheduledRequests = new Map<string, number>();

  /** В Звезде открыт канал, а не карта офиса и не «Файлы». */
  function channelOnScreen(starId: string): boolean {
    const view = get().viewByStar[starId] ?? (get().details[starId]?.kind === "work" ? "map" : "channel");
    return view === "channel";
  }

  function activeChannelId(): string | null {
    const { activeStarId, activeChannelByStar } = get();
    return activeStarId ? (activeChannelByStar[activeStarId] ?? null) : null;
  }

  function patchDetail(starId: string, patch: (d: StarDetail) => StarDetail) {
    const detail = get().details[starId];
    if (!detail) return;
    const next = patch(detail);
    set((s) => ({
      details: { ...s.details, [starId]: { ...next, members: sortMembers(next.members) } },
      stars: s.stars.map((st) => (st.id === starId ? summaryOf(next) : st)),
    }));
  }

  /** Добавляет Звезду в список и делает активной. */
  function adoptDetail(detail: StarDetail) {
    set((s) => ({
      stars: s.stars.some((st) => st.id === detail.id)
        ? s.stars.map((st) => (st.id === detail.id ? summaryOf(detail) : st))
        : [...s.stars, summaryOf(detail)],
      details: { ...s.details, [detail.id]: { ...detail, members: sortMembers(detail.members) } },
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
    for (const channel of get().details[starId]?.channels ?? []) scheduledRequests.delete(channel.id);
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
      const scheduled = Object.fromEntries(
        Object.entries(s.scheduled).filter(([, items]) => !items.some((x) => x.star_id === starId))
      );
      return { details, unread, stars, activeStarId, mobileChannelOpen: false, thread, scheduled };
    });
    const nextActive = get().activeStarId;
    if (nextActive && !get().details[nextActive]) void get().refreshStar(nextActive);
  }

  function handleEvent(event: StarEvent) {
    const { star_id: starId } = event;
    switch (event.type) {
      case "star_scheduled_changed": {
        if (get().scheduled[event.channel_id]) {
          void get().loadScheduled(starId, event.channel_id).catch(() => {});
        }
        if (event.error) notifyInfo({ title: "Отложенное сообщение не отправлено", body: event.error });
        break;
      }
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
        scheduledRequests.delete(event.channel_id);
        patchDetail(starId, (d) => ({
          ...d,
          channels: d.channels.filter((c) => c.id !== event.channel_id),
        }));
        set((s) => {
          const messages = { ...s.messages };
          delete messages[event.channel_id];
          const scheduled = { ...s.scheduled };
          delete scheduled[event.channel_id];
          const unread = { ...s.unread };
          delete unread[event.channel_id];
          const activeChannelByStar = { ...s.activeChannelByStar };
          if (activeChannelByStar[starId] === event.channel_id) {
            activeChannelByStar[starId] = firstSatellite(s.details[starId]);
          }
          return { messages, unread, activeChannelByStar, scheduled };
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
        const me = myId();
        const mentioned = mentionsMe(message, me);
        // Ответ в ветке — только в открытую ветку; сводку под корнем обновит star_thread.
        if (message.thread_id) {
          const root = get().messages[message.channel_id]?.find((m) => m.id === message.thread_id);
          const inThread = get().thread?.rootId === message.thread_id;
          // В ветке тревожим только тех, кого упомянули или чья это ветка — даже при «Все сообщения».
          const mine = mentioned || (!!me && root?.sender?.id === me);
          if (message.sender?.id !== me && mine) maybeNotify(starId, message, true, inThread);
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
          channelOnScreen(starId) &&
          document.visibilityState === "visible";
        if (message.sender?.id !== me && !viewing) {
          set((s) => ({
            unread: {
              ...s.unread,
              [message.channel_id]: {
                starId,
                count: (s.unread[message.channel_id]?.count ?? 0) + 1,
                mentions: (s.unread[message.channel_id]?.mentions ?? 0) + (mentioned ? 1 : 0),
              },
            },
          }));
        }
        if (message.sender?.id !== me) maybeNotify(starId, message, mentioned, viewing);
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
          const voice_since = { ...(d.voice_since ?? {}) };
          if (event.participants.length) voice[event.channel_id] = event.participants;
          else delete voice[event.channel_id];
          if (event.participants.length && event.active_since) voice_since[event.channel_id] = event.active_since;
          else delete voice_since[event.channel_id];
          return { ...d, voice, voice_since };
        });
        break;
      case "star_pins":
        if (get().pins[event.channel_id] || activeChannelId() === event.channel_id) {
          void get().loadPins(starId, event.channel_id).catch(() => {});
        }
        break;
      case "star_bookmarks":
        set((s) => ({ bookmarks: { ...s.bookmarks, [event.channel_id]: event.bookmarks } }));
        break;
      case "star_message_deleted":
        if (get().thread?.rootId === event.message_id) set({ thread: null });
        set((s) =>
          s.pins[event.channel_id]
            ? { pins: { ...s.pins, [event.channel_id]: s.pins[event.channel_id].filter((m) => m.id !== event.message_id) } }
            : {}
        );
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
            if (m.id === event.message_id) {
              return {
                ...m,
                text: event.text,
                edited_at: event.edited_at,
                mentions: event.mentions ?? m.mentions,
                mention_all: event.mention_all ?? m.mention_all,
                // Текст другой — старое превью сервер убрал.
                link_preview: null,
              };
            }
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

  /** Всплывашка и звук — по моему уровню уведомлений, не на экране и не в нерабочее время. */
  function maybeNotify(starId: string, message: StarMessage, mentioned: boolean, onScreen: boolean) {
    if (onScreen && document.visibilityState === "visible") return;
    const level = channelLevel(useNotifyStore.getState().settings, starId, message.channel_id);
    if (!wants(level, mentioned)) return;
    const detail = get().details[starId];
    const me = detail?.members.find((m) => m.user.id === myId());
    if (detail && me && memberWorkState(detail, me)?.working === false) return;
    const channel = detail?.channels.find((c) => c.id === message.channel_id);
    const where = `#${channel?.name ?? "Спутник"}${message.thread_id ? " · ветка" : ""}`;
    void notifyStarMessage({
      title: `${displayName(message.sender) ?? "Участник"} · ${where} · ${detail?.name ?? "Звезда"}`,
      body: stripMarkup(message.text) || (message.file ? `📎 ${message.file.name}` : ""),
      starId,
      channelId: message.channel_id,
    });
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
  // было, могли принять в Звезду или выгнать. Открытую Звезду перечитываем: события о том,
  // кто вошёл в Комнаты и вышел из них, без связи потерялись.
  socket.onStatus((open) => {
    if (!open || !get().loaded) return;
    const { activeStarId, details } = get();
    const reload = activeStarId && details[activeStarId] ? activeStarId : null;
    void get()
      .syncList()
      .then(() => {
        if (reload && get().details[reload]) void get().refreshStar(reload);
      });
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

    sendMessage: async (text, replyToId, ackRequired, linkPreview) => {
      const starId = get().activeStarId;
      const channelId = activeChannelId();
      if (!starId || !channelId) return;
      const message = await starsApi.send(starId, channelId, text, replyToId, {
        ...(ackRequired ? { ack_required: true } : {}),
        ...(linkPreview ? { link_preview: linkPreview } : {}),
      });
      handleEvent({ type: "star_message", star_id: starId, message });
    },

    loadScheduled: async (starId, channelId) => {
      const userId = myId();
      const request = ++scheduledRevision;
      scheduledRequests.set(channelId, request);
      const items = await starsApi.scheduled(starId, channelId);
      if (userId !== myId() || scheduledRequests.get(channelId) !== request) return;
      set((s) => ({ scheduled: { ...s.scheduled, [channelId]: items } }));
    },

    scheduleMessage: async (starId, channelId, text, at, extra) => {
      const userId = myId();
      const item = await starsApi.schedule(starId, channelId, text, at, extra);
      if (userId !== myId()) return;
      scheduledRequests.set(channelId, ++scheduledRevision);
      set((s) => ({
        scheduled: {
          ...s.scheduled,
          [channelId]: [...(s.scheduled[channelId] ?? []).filter((x) => x.id !== item.id), item]
            .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at)),
        },
      }));
    },

    cancelScheduled: async (starId, channelId, id) => {
      const userId = myId();
      await starsApi.cancelScheduled(starId, channelId, id);
      if (userId !== myId()) return;
      scheduledRequests.set(channelId, ++scheduledRevision);
      set((s) => ({
        scheduled: { ...s.scheduled, [channelId]: (s.scheduled[channelId] ?? []).filter((x) => x.id !== id) },
      }));
    },

    sendFile: async (file, opts = {}) => {
      const thread = opts.inThread ? get().thread : null;
      const starId = thread?.starId ?? get().activeStarId;
      const channelId = thread?.channelId ?? activeChannelId();
      if (!starId || !channelId) return;
      const uploaded = await starsApi.uploadFile(starId, channelId, file, opts.onProgress);
      const message = await starsApi.send(starId, channelId, opts.caption ?? "", undefined, {
        file_id: uploaded.id,
        ...(thread ? { thread_id: thread.rootId } : {}),
      });
      handleEvent({ type: "star_message", star_id: starId, message });
    },

    loadPins: async (starId, channelId) => {
      const list = await starsApi.pins(starId, channelId);
      set((s) => ({ pins: { ...s.pins, [channelId]: list } }));
    },

    loadBookmarks: async (starId, channelId) => {
      const list = await starsApi.bookmarks(starId, channelId);
      set((s) => ({ bookmarks: { ...s.bookmarks, [channelId]: list } }));
    },

    pinMessage: async (message, pinned) => {
      if (pinned) await starsApi.pin(message.star_id, message.channel_id, message.id);
      else await starsApi.unpin(message.star_id, message.channel_id, message.id);
      await get().loadPins(message.star_id, message.channel_id);
    },

    jumpTo: async (message) => {
      await get().openChannelLink(message.star_id, message.channel_id);
      if (message.thread_id) {
        // Ответ в ветке — открываем ветку его корня.
        // Передаём сам ответ: openThread откроет ветку его корня и загрузит её целиком.
        await get().openThread(message as StarMessage);
        return;
      }
      for (let i = 0; i < 40; i++) {
        if ((get().messages[message.channel_id] ?? []).some((m) => m.id === message.id)) break;
        if (!get().hasMore[message.channel_id]) break;
        await get().loadOlder(message.channel_id);
      }
      set({ revealRequest: { channelId: message.channel_id, messageId: message.id } });
    },

    clearReveal: () => set({ revealRequest: null }),

    setView: (starId, view) => set((s) => ({ viewByStar: { ...s.viewByStar, [starId]: view } })),

    openChannelLink: async (starId, channelId) => {
      useUiStore.getState().setTab("stars");
      if (!get().loaded) await get().load().catch(() => {});
      if (!get().stars.some((st) => st.id === starId)) return;
      set((s) => ({ viewByStar: { ...s.viewByStar, [starId]: "channel" }, mobileChannelOpen: true }));
      await get().selectStar(starId);
      await get().selectChannel(channelId);
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

/** Непрочитанные упоминания по Звезде — значок «@». */
export function mentionsForStar(unread: Record<string, Unread>, starId: string): number {
  let total = 0;
  for (const u of Object.values(unread)) if (u.starId === starId) total += u.mentions ?? 0;
  return total;
}
