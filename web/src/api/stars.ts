import { http } from "./client";
import type { LinkPreview } from "../chat/linkPreview";

export type StarKind = "gaming" | "work";
export type StarRole = "owner" | "admin" | "moderator" | "member";
export type ChannelKind = "satellite" | "planet";
export type RoomKind = "coworking" | "meeting" | "smoking" | "kitchen" | "custom" | "lobby";
/** Вход в Планету: свободный, по приглашениям (стучаться) или личный кабинет (Звёзды «Работа»). */
export type RoomAccess = "open" | "invite" | "personal";
export type StarPerm =
  | "invite"
  | "delete_messages"
  | "kick"
  | "manage_channels"
  | "voice_moderate"
  | "edit_map"
  | "admit";

export interface StarUser {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface StarMember {
  user: StarUser;
  role: StarRole;
  joined_at: string;
  /** Свои роли-подписи (StarTag.id). */
  tag_ids?: string[];
  /** В тайм-ауте до этого момента. */
  timeout_until?: string | null;
  /** Свой рабочий график (приходит, только если в Звезде включено рабочее время). */
  work_schedule?: WorkSchedule | null;
}

/** Рабочий график: дни 1..7 (пн = 1), время «ЧЧ:ММ», часовой пояс IANA. end < start — смена через полночь. */
export interface WorkSchedule {
  days: number[];
  start: string;
  end: string;
  tz: string;
}

export type DoorSignKind = "dnd" | "welcome" | "away" | "custom";

/** Бронь переговорной. */
export interface StarBooking {
  id: string;
  channel_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  created_by: string | null;
  attendees: string[];
}

/** Файл в сообщении Спутника. */
export interface StarFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Файл в разделе «Файлы» Звезды. */
export interface StarFileItem extends StarFile {
  channel_id: string;
  message_id: string | null;
  uploader: StarUser | null;
  created_at: string;
}

export interface StarFilesPage {
  files: StarFileItem[];
  used_bytes: number;
  quota_bytes: number;
}

/** Входящий вебхук (интеграция) Спутника. */
export interface StarWebhook {
  id: string;
  channel_id: string;
  name: string;
  kind: WebhookKind;
  token: string;
  created_at: string;
  last_used_at: string | null;
  last_error: string | null;
}

export type WebhookKind = "auto" | "github" | "gitlab" | "jira" | "grafana" | "alertmanager" | "generic";

/** Адрес, который вставляют в настройки внешнего сервиса. */
export function webhookUrl(hook: Pick<StarWebhook, "id" | "token">): string {
  return `${window.location.origin}/api/hooks/${hook.id}/${hook.token}`;
}

/** Гостевая ссылка в комнату. */
export interface GuestLink {
  id: string;
  code: string;
  channel_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  uses: number;
}

export function guestLinkUrl(code: string): string {
  return `${window.location.origin}/guest/${code}`;
}

export interface StarAcks {
  acked: StarUser[];
  pending: StarUser[];
}

/** Своя роль с цветом: подпись и цвет имени, права не даёт. */
export interface StarTag {
  id: string;
  name: string;
  color: string;
  /** Участник может выбрать её себе сам. */
  self_assign: boolean;
  position: number;
}

export interface PollOption {
  text: string;
  votes: number;
  /** Кто голосовал — только в неанонимных опросах. */
  voters: string[];
}

export interface StarPoll {
  id: string;
  question: string;
  options: PollOption[];
  multiple: boolean;
  anonymous: boolean;
  closes_at: string | null;
  closed: boolean;
  total_voters: number;
  /** Мои варианты (в рассылке другим — пусто). */
  my_votes: number[];
  created_by: string | null;
}

export interface StarLfg {
  id: string;
  title: string;
  slots: number;
  starts_at: string | null;
  status: "open" | "started" | "cancelled";
  members: string[];
  /** Временная Планета, когда сбор начался. */
  planet_id: string | null;
  created_by: string | null;
}

export type AssetKind = "sticker" | "emoji" | "sound";

export interface StarAsset {
  id: string;
  kind: AssetKind;
  name: string;
  emoji: string | null;
  url: string;
  mime: string;
}

export interface AuditEntry {
  id: string;
  actor: StarUser | null;
  action: string;
  target: StarUser | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface CommunitySettings {
  rules_text?: string | null;
  welcome_text?: string | null;
  welcome_channel_id?: string | null;
  banned_words?: string[];
  soundboard?: boolean;
}

export interface StarChannel {
  id: string;
  star_id: string;
  kind: ChannelKind;
  name: string;
  position: number;
  capacity: number | null;
  room_kind: RoomKind | null;
  access: RoomAccess;
  /** Хозяин личного кабинета (access === "personal"). */
  cabinet_owner_id?: string | null;
  /** «Только слушать»: микрофоны на Планете не открываются (показ экрана работает). */
  listen_only?: boolean;
  /** Медленный режим Спутника, секунды (0 — выключен). */
  slow_mode_sec?: number;
  /** Временная Планета: исчезнет, когда опустеет. */
  temporary?: boolean;
  created_by?: string | null;
  /** Спутник-объявления: пишут владелец и админы, остальные — в ветках. */
  announcement?: boolean;
  /** Табличка на двери личного кабинета (истёкшая не приходит). */
  door_sign_kind?: DoorSignKind | null;
  door_sign_text?: string | null;
  door_sign_until?: string | null;
  /** Этаж карты офиса (Звёзды «Работа»). */
  floor_id: string | null;
  map_x: number | null;
  map_y: number | null;
  map_w: number | null;
  map_h: number | null;
}

export interface StarSummary {
  id: string;
  name: string;
  kind: StarKind;
  owner_id: string;
  /** /media/avatars/stars/<id>.<ext>?v=… или null — тогда инициалы. */
  avatar_url: string | null;
  /** Фон для всех участников (/media/backgrounds/…) или null — у каждого свой. */
  background_url: string | null;
  created_at: string;
  member_count: number;
  my_role: StarRole;
}

export interface RolePermissions {
  moderator: StarPerm[];
  member: StarPerm[];
}

export interface StarFloor {
  id: string;
  name: string;
  position: number;
  /** Растёт при каждом сохранении плана. */
  version: number;
}

export interface LayoutRoom {
  channel_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type KnockAnswer = "admit" | "wait" | "deny";
/** Ответ на стук от сервера: ещё и «комната освободилась — заходите». */
export type KnockOutcome = KnockAnswer | "free";

export interface Knock {
  id: string;
  star_id: string;
  channel_id: string;
  user_id: string;
  status: "pending" | "waiting";
  lobby_channel_id: string | null;
}

export interface KnockEvent {
  type: "planet_knock";
  star_id: string;
  knock: Knock;
  user_name: string;
  room_name: string;
  star_name: string;
  expires_in: number;
}

export interface VoicePresence {
  user_id: string;
  joined_at: string;
  /** Модератор выключил микрофон. */
  server_muted: boolean;
  /** Показывает экран (на Планете — не больше одного). */
  screen_sharing?: boolean;
  /** Главный в комнате «По приглашениям». */
  is_host?: boolean;
  /** Гость по ссылке (без аккаунта): его имя; user_id тогда — guest-…. */
  guest_name?: string | null;
}

export interface StarDetail extends StarSummary {
  my_permissions: StarPerm[];
  role_permissions: RolePermissions;
  channels: StarChannel[];
  members: StarMember[];
  /** Кто сейчас на какой Планете: channel_id → участники. */
  voice: Record<string, VoicePresence[]>;
  /** Этажи карты офиса (только у Звёзд «Работа»). */
  floors: StarFloor[];
  rules_text?: string | null;
  /** Правила приняты (или их нет, или я модератор и выше). */
  rules_accepted?: boolean;
  welcome_text?: string | null;
  welcome_channel_id?: string | null;
  soundboard?: boolean;
  /** Только владельцу и админам. */
  banned_words?: string[];
  tags?: StarTag[];
  /** Рабочее время: включено ли (настраивают владелец и админы) и общий график Звезды. */
  work_hours_enabled?: boolean;
  work_hours?: WorkSchedule | null;
}

export interface PlanetJoin {
  url: string;
  token: string;
  room: string;
}

export interface StarMessageReply {
  id: string;
  sender: StarUser | null;
  text: string;
}

export interface StarMessageReaction {
  user_id: string;
  emoji: string;
}

export interface StarMessage {
  id: string;
  star_id: string;
  channel_id: string;
  sender: StarUser | null;
  text: string;
  created_at: string;
  edited_at?: string | null;
  reply_to?: StarMessageReply | null;
  reactions?: StarMessageReaction[];
  /** text | system (приветствие) | poll | lfg | file | bot (интеграция) */
  kind?: "text" | "system" | "poll" | "lfg" | "file" | "bot";
  /** Превью первой ссылки (собрал отправитель). */
  link_preview?: LinkPreview | null;
  /** Сообщение интеграции: имя вебхука и сервис (github, gitlab, jira, grafana, alertmanager, generic). */
  bot_name?: string | null;
  bot_kind?: string | null;
  /** У kind === "file"; text тогда — подпись (может быть пустой). */
  file?: StarFile | null;
  /** Упомянутые (@имя) участники и @все. */
  mentions?: string[];
  mention_all?: boolean;
  poll?: StarPoll | null;
  lfg?: StarLfg | null;
  /** Ответ в ветке — id корня. У корня — сводка ветки. */
  thread_id?: string | null;
  thread_count?: number;
  thread_last_at?: string | null;
  /** До трёх последних отвечавших, свежие первыми. */
  thread_participants?: string[];
  /** Объявление с «Ознакомлен(а)». */
  ack_required?: boolean;
  ack_count?: number;
  acked?: boolean;
}

export interface StarInvite {
  code: string;
  star_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
}

export interface InvitePreview {
  code: string;
  star_id: string;
  star_name: string;
  star_kind: StarKind;
  star_avatar_url: string | null;
  member_count: number;
  already_member: boolean;
}

export interface StarBan {
  user: StarUser;
  banned_by: string | null;
  created_at: string;
}

export interface StarLimits {
  max_owned_stars: number;
  owned_stars: number;
  max_star_members: number;
  gaming_max_satellites: number;
  gaming_max_planets: number;
  planet_max_capacity: number;
  room_kinds: Record<RoomKind, number>;
}

export type StarEvent =
  | {
      type: "star_updated";
      star_id: string;
      name: string;
      owner_id: string;
      avatar_url: string | null;
      background_url: string | null;
    }
  | { type: "star_removed"; star_id: string; reason: "kick" | "ban" | "leave" | "deleted" }
  | { type: "star_member_upsert"; star_id: string; member: StarMember }
  | { type: "star_member_removed"; star_id: string; user_id: string; reason: string }
  | { type: "star_permissions"; star_id: string; role_permissions: RolePermissions }
  | { type: "star_channel_upsert"; star_id: string; channel: StarChannel }
  | { type: "star_channel_deleted"; star_id: string; channel_id: string }
  | { type: "star_channels_order"; star_id: string; channel_ids: string[] }
  | { type: "star_message"; star_id: string; message: StarMessage }
  | { type: "star_floors"; star_id: string; floors: StarFloor[] }
  | {
      type: "planet_invite";
      star_id: string;
      channel_id: string;
      from_user_id: string;
      from_name: string;
      room_name: string;
      star_name: string;
      expires_in: number;
    }
  | KnockEvent
  | { type: "planet_knock_closed"; star_id: string; knock_id: string }
  | {
      type: "planet_knock_answer";
      star_id: string;
      channel_id: string;
      knock_id: string;
      action: KnockOutcome;
      room_name: string;
      star_name: string;
      by_name: string;
      lobby_channel_id?: string;
    }
  | { type: "star_layout"; star_id: string; floor: StarFloor; rooms: LayoutRoom[] }
  | {
      type: "star_voice";
      star_id: string;
      channel_id: string;
      participants: VoicePresence[];
    }
  | {
      type: "star_message_deleted";
      star_id: string;
      channel_id: string;
      message_id: string;
    }
  | {
      type: "star_message_edited";
      star_id: string;
      channel_id: string;
      message_id: string;
      text: string;
      edited_at: string;
      mentions?: string[];
      mention_all?: boolean;
    }
  /** Закреплённые в Спутнике изменились (свежие первыми). */
  | { type: "star_pins"; star_id: string; channel_id: string; message_ids: string[] }
  /** emoji null — реакцию сняли. */
  | {
      type: "star_message_reaction";
      star_id: string;
      channel_id: string;
      message_id: string;
      user_id: string;
      emoji: string | null;
    }
  | { type: "star_typing"; star_id: string; channel_id: string; user_id: string }
  | {
      type: "star_community";
      star_id: string;
      rules_text: string | null;
      welcome_text: string | null;
      welcome_channel_id: string | null;
      soundboard: boolean;
    }
  | { type: "star_tags"; star_id: string; tags: StarTag[] }
  | { type: "star_poll"; star_id: string; channel_id: string; message_id: string; poll: StarPoll }
  | { type: "star_lfg"; star_id: string; channel_id: string; message_id: string; lfg: StarLfg }
  /** Сбор, на который я записался, начался — зовут на временную Планету. */
  | {
      type: "star_lfg_start";
      star_id: string;
      lfg_id: string;
      channel_id: string;
      title: string;
      star_name: string;
    }
  | { type: "star_assets"; star_id: string }
  | {
      type: "star_thread";
      star_id: string;
      channel_id: string;
      root_id: string;
      count: number;
      last_at: string | null;
      participants: string[];
    }
  | { type: "star_ack"; star_id: string; channel_id: string; message_id: string; ack_count: number }
  | { type: "star_work_hours"; star_id: string; enabled: boolean; schedule: WorkSchedule | null }
  | { type: "star_bookings"; star_id: string; channel_id: string }
  /** Через 10 минут встреча, на которую меня позвали. */
  | {
      type: "star_booking_soon";
      star_id: string;
      channel_id: string;
      booking_id: string;
      title: string;
      room: string | null;
      starts_at: string;
    }
  /** Кто-то на моей Планете нажал звук панели. */
  | { type: "star_sound"; star_id: string; channel_id: string; url: string; name: string; by: string };

const base = (starId: string) => `/stars/${starId}`;

export const starsApi = {
  limits: () => http.get<StarLimits>("/stars/limits").then((r) => r.data),
  list: () => http.get<StarSummary[]>("/stars").then((r) => r.data),
  get: (starId: string) => http.get<StarDetail>(base(starId)).then((r) => r.data),
  create: (name: string, kind: StarKind) =>
    http.post<StarDetail>("/stars", { name, kind }).then((r) => r.data),
  rename: (starId: string, name: string) =>
    http.patch<StarDetail>(base(starId), { name }).then((r) => r.data),
  remove: (starId: string) => http.delete(base(starId)),
  uploadAvatar: (starId: string, file: Blob) => {
    const form = new FormData();
    form.append("file", file, "avatar");
    return http.post<StarDetail>(`${base(starId)}/avatar`, form).then((r) => r.data);
  },
  removeAvatar: (starId: string) =>
    http.delete<StarDetail>(`${base(starId)}/avatar`).then((r) => r.data),
  uploadBackground: (starId: string, file: Blob) => {
    const form = new FormData();
    form.append("file", file, "background");
    return http.post<StarDetail>(`${base(starId)}/background`, form).then((r) => r.data);
  },
  removeBackground: (starId: string) =>
    http.delete<StarDetail>(`${base(starId)}/background`).then((r) => r.data),
  transfer: (starId: string, userId: string) =>
    http.post<StarDetail>(`${base(starId)}/transfer`, { user_id: userId }).then((r) => r.data),
  leave: (starId: string) => http.post(`${base(starId)}/leave`),

  setRole: (starId: string, userId: string, role: Exclude<StarRole, "owner">) =>
    http.patch<StarMember>(`${base(starId)}/members/${userId}`, { role }).then((r) => r.data),
  kick: (starId: string, userId: string) => http.post(`${base(starId)}/members/${userId}/kick`),
  ban: (starId: string, userId: string) => http.post(`${base(starId)}/members/${userId}/ban`),
  bans: (starId: string) => http.get<StarBan[]>(`${base(starId)}/bans`).then((r) => r.data),
  unban: (starId: string, userId: string) => http.delete(`${base(starId)}/bans/${userId}`),
  setPermissions: (starId: string, perms: RolePermissions) =>
    http.put<RolePermissions>(`${base(starId)}/permissions`, perms).then((r) => r.data),

  createInvite: (starId: string, opts: { expires_in_hours?: number; max_uses?: number }) =>
    http.post<StarInvite>(`${base(starId)}/invites`, opts).then((r) => r.data),
  invites: (starId: string) =>
    http.get<StarInvite[]>(`${base(starId)}/invites`).then((r) => r.data),
  revokeInvite: (starId: string, code: string) =>
    http.delete(`${base(starId)}/invites/${encodeURIComponent(code)}`),
  previewInvite: (code: string) =>
    http.get<InvitePreview>(`/star-invites/${encodeURIComponent(code)}`).then((r) => r.data),
  joinInvite: (code: string) =>
    http.post<StarDetail>(`/star-invites/${encodeURIComponent(code)}/join`).then((r) => r.data),

  createChannel: (
    starId: string,
    body: {
      kind: ChannelKind;
      name: string;
      capacity?: number;
      room_kind?: RoomKind;
      access?: RoomAccess;
      cabinet_owner_id?: string;
      listen_only?: boolean;
      announcement?: boolean;
      floor_id?: string;
    }
  ) => http.post<StarChannel>(`${base(starId)}/channels`, body).then((r) => r.data),
  updateChannel: (
    starId: string,
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
  ) => http.patch<StarChannel>(`${base(starId)}/channels/${channelId}`, body).then((r) => r.data),
  deleteChannel: (starId: string, channelId: string) =>
    http.delete(`${base(starId)}/channels/${channelId}`),

  messages: (starId: string, channelId: string, beforeId?: string) =>
    http
      .get<StarMessage[]>(`${base(starId)}/channels/${channelId}/messages`, {
        params: beforeId ? { before_id: beforeId } : {},
      })
      .then((r) => r.data),
  send: (
    starId: string,
    channelId: string,
    text: string,
    replyToId?: string,
    extra: { thread_id?: string; ack_required?: boolean; file_id?: string; link_preview?: LinkPreview } = {}
  ) =>
    http
      .post<StarMessage>(`${base(starId)}/channels/${channelId}/messages`, {
        text,
        reply_to_id: replyToId,
        ...extra,
      })
      .then((r) => r.data),
  /** Сам файл — телом запроса; потом он уходит в сообщении (send … { file_id }). */
  uploadFile: (starId: string, channelId: string, file: File, onProgress?: (share: number) => void) =>
    http
      .post<StarFile>(`${base(starId)}/channels/${channelId}/files`, file, {
        params: { name: file.name },
        headers: { "Content-Type": file.type || "application/octet-stream" },
        onUploadProgress: onProgress
          ? (e) => onProgress(e.total ? Math.min(1, e.loaded / e.total) : 0)
          : undefined,
      })
      .then((r) => r.data),
  files: (
    starId: string,
    params: { q?: string; channel_id?: string; kind?: "all" | "images" | "docs"; before?: string } = {}
  ) => http.get<StarFilesPage>(`${base(starId)}/files`, { params }).then((r) => r.data),
  downloadFile: (starId: string, fileId: string) =>
    http
      .get<ArrayBuffer>(`${base(starId)}/files/${fileId}`, { responseType: "arraybuffer" })
      .then((r) => new Uint8Array(r.data)),
  pins: (starId: string, channelId: string) =>
    http.get<StarMessage[]>(`${base(starId)}/channels/${channelId}/pins`).then((r) => r.data),
  pin: (starId: string, channelId: string, messageId: string) =>
    http.put(`${base(starId)}/channels/${channelId}/pins/${messageId}`),
  unpin: (starId: string, channelId: string, messageId: string) =>
    http.delete(`${base(starId)}/channels/${channelId}/pins/${messageId}`),
  search: (starId: string, q: string, params: { channel_id?: string; before?: string } = {}) =>
    http.get<StarMessage[]>(`${base(starId)}/search`, { params: { q, ...params } }).then((r) => r.data),
  webhooks: (starId: string) => http.get<StarWebhook[]>(`${base(starId)}/webhooks`).then((r) => r.data),
  createWebhook: (starId: string, channelId: string, body: { name: string; kind: WebhookKind }) =>
    http.post<StarWebhook>(`${base(starId)}/channels/${channelId}/webhooks`, body).then((r) => r.data),
  updateWebhook: (
    starId: string,
    webhookId: string,
    body: { name?: string; kind?: WebhookKind; channel_id?: string; new_token?: boolean }
  ) => http.patch<StarWebhook>(`${base(starId)}/webhooks/${webhookId}`, body).then((r) => r.data),
  deleteWebhook: (starId: string, webhookId: string) => http.delete(`${base(starId)}/webhooks/${webhookId}`),
  guestLinks: (starId: string, channelId: string) =>
    http.get<GuestLink[]>(`${base(starId)}/planets/${channelId}/guest-links`).then((r) => r.data),
  createGuestLink: (starId: string, channelId: string, hours: number) =>
    http.post<GuestLink>(`${base(starId)}/planets/${channelId}/guest-links`, { hours }).then((r) => r.data),
  revokeGuestLink: (starId: string, linkId: string) => http.delete(`${base(starId)}/guest-links/${linkId}`),
  thread: (starId: string, channelId: string, rootId: string) =>
    http
      .get<StarMessage[]>(`${base(starId)}/channels/${channelId}/threads/${rootId}`)
      .then((r) => r.data),
  ack: (starId: string, messageId: string) =>
    http.post<{ ack_count: number }>(`${base(starId)}/messages/${messageId}/ack`).then((r) => r.data),
  acks: (starId: string, messageId: string) =>
    http.get<StarAcks>(`${base(starId)}/messages/${messageId}/acks`).then((r) => r.data),
  setWorkHours: (starId: string, enabled: boolean, schedule?: WorkSchedule) =>
    http.put(`${base(starId)}/work-hours`, { enabled, schedule }),
  bookings: (starId: string, from?: string, to?: string) =>
    http
      .get<StarBooking[]>(`${base(starId)}/bookings`, { params: { from, to } })
      .then((r) => r.data),
  book: (
    starId: string,
    channelId: string,
    body: { title: string; starts_at: string; ends_at: string; attendees: string[] }
  ) =>
    http
      .post<StarBooking>(`${base(starId)}/channels/${channelId}/bookings`, body)
      .then((r) => r.data),
  cancelBooking: (starId: string, bookingId: string) =>
    http.delete(`${base(starId)}/bookings/${bookingId}`),
  doorSign: (
    starId: string,
    channelId: string,
    body: { kind: DoorSignKind | null; text?: string | null; until?: string | null }
  ) => http.put(`${base(starId)}/channels/${channelId}/door-sign`, body),
  editMessage: (starId: string, channelId: string, messageId: string, text: string) =>
    http
      .patch<StarMessage>(`${base(starId)}/channels/${channelId}/messages/${messageId}`, { text })
      .then((r) => r.data),
  deleteMessage: (starId: string, channelId: string, messageId: string) =>
    http.delete(`${base(starId)}/channels/${channelId}/messages/${messageId}`),
  community: (starId: string, body: CommunitySettings) => http.patch(`${base(starId)}/community`, body),
  acceptRules: (starId: string) => http.post(`${base(starId)}/rules/accept`),
  createTag: (starId: string, body: { name: string; color: string; self_assign: boolean }) =>
    http.post<StarTag>(`${base(starId)}/tags`, body).then((r) => r.data),
  updateTag: (starId: string, tagId: string, body: { name: string; color: string; self_assign: boolean }) =>
    http.patch<StarTag>(`${base(starId)}/tags/${tagId}`, body).then((r) => r.data),
  deleteTag: (starId: string, tagId: string) => http.delete(`${base(starId)}/tags/${tagId}`),
  giveTag: (starId: string, userId: string, tagId: string) =>
    http.put(`${base(starId)}/members/${userId}/tags/${tagId}`),
  takeTag: (starId: string, userId: string, tagId: string) =>
    http.delete(`${base(starId)}/members/${userId}/tags/${tagId}`),
  timeout: (starId: string, userId: string, minutes: number | null) =>
    http.post(`${base(starId)}/members/${userId}/timeout`, { minutes }),
  audit: (starId: string, before?: string) =>
    http
      .get<AuditEntry[]>(`${base(starId)}/audit`, { params: before ? { before } : {} })
      .then((r) => r.data),
  createPoll: (
    starId: string,
    channelId: string,
    body: { question: string; options: string[]; multiple: boolean; anonymous: boolean; closes_in_minutes: number | null }
  ) => http.post(`${base(starId)}/channels/${channelId}/polls`, body),
  vote: (starId: string, pollId: string, options: number[]) =>
    http.put<StarPoll>(`${base(starId)}/polls/${pollId}/vote`, { options }).then((r) => r.data),
  closePoll: (starId: string, pollId: string) => http.post(`${base(starId)}/polls/${pollId}/close`),
  createLfg: (starId: string, channelId: string, body: { title: string; slots: number; starts_at: string | null }) =>
    http.post(`${base(starId)}/channels/${channelId}/lfg`, body),
  lfgAction: (starId: string, lfgId: string, action: "join" | "leave" | "start" | "cancel") =>
    http.post<StarLfg>(`${base(starId)}/lfg/${lfgId}/${action}`).then((r) => r.data),
  temporaryPlanet: (starId: string, name?: string) =>
    http.post<StarChannel>(`${base(starId)}/planets/temporary`, { name: name ?? null }).then((r) => r.data),
  assets: (starId: string) => http.get<StarAsset[]>(`${base(starId)}/assets`).then((r) => r.data),
  uploadAsset: (starId: string, kind: AssetKind, name: string, file: File, emoji?: string) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("name", name);
    if (emoji) form.append("emoji", emoji);
    form.append("file", file);
    return http.post<StarAsset>(`${base(starId)}/assets`, form).then((r) => r.data);
  },
  deleteAsset: (starId: string, assetId: string) => http.delete(`${base(starId)}/assets/${assetId}`),
  playSound: (starId: string, channelId: string, sound: string) =>
    http.post(`${base(starId)}/planets/${channelId}/sound`, { sound }),

  react: (starId: string, channelId: string, messageId: string, emoji: string) =>
    http.put(`${base(starId)}/channels/${channelId}/messages/${messageId}/reaction`, { emoji }),
  unreact: (starId: string, channelId: string, messageId: string) =>
    http.delete(`${base(starId)}/channels/${channelId}/messages/${messageId}/reaction`),

  createFloor: (starId: string, name: string) =>
    http.post<StarFloor>(`${base(starId)}/floors`, { name }).then((r) => r.data),
  renameFloor: (starId: string, floorId: string, name: string) =>
    http.patch<StarFloor>(`${base(starId)}/floors/${floorId}`, { name }).then((r) => r.data),
  deleteFloor: (starId: string, floorId: string) => http.delete(`${base(starId)}/floors/${floorId}`),
  saveLayout: (starId: string, floorId: string, version: number, rooms: LayoutRoom[]) =>
    http
      .put<{ floor: StarFloor; rooms: LayoutRoom[] }>(`${base(starId)}/floors/${floorId}/layout`, {
        version,
        rooms,
      })
      .then((r) => r.data),

  invite: (starId: string, channelId: string, userId: string) =>
    http.post(`${base(starId)}/planets/${channelId}/invite`, { user_id: userId }),
  knock: (starId: string, channelId: string) =>
    http.post<Knock>(`${base(starId)}/planets/${channelId}/knock`).then((r) => r.data),
  cancelKnock: (starId: string, knockId: string) =>
    http.delete(`${base(starId)}/knocks/${knockId}`),
  answerKnock: (starId: string, knockId: string, action: KnockAnswer) =>
    http.post(`${base(starId)}/knocks/${knockId}/answer`, { action }),
  makeHost: (starId: string, channelId: string, userId: string) =>
    http.post(`${base(starId)}/planets/${channelId}/host`, { user_id: userId }),
  knocks: (starId: string) =>
    http.get<KnockEvent[]>(`${base(starId)}/knocks`).then((r) => r.data),

  joinPlanet: (starId: string, channelId: string) =>
    http.post<PlanetJoin>(`${base(starId)}/planets/${channelId}/join`).then((r) => r.data),
  voiceMute: (starId: string, channelId: string, userId: string, muted: boolean) =>
    http.post(`${base(starId)}/planets/${channelId}/voice/${userId}/mute`, { muted }),
  voiceRemove: (starId: string, channelId: string, userId: string) =>
    http.post(`${base(starId)}/planets/${channelId}/voice/${userId}/remove`),
  startScreen: (starId: string, channelId: string) =>
    http.post(`${base(starId)}/planets/${channelId}/screen`),
  stopScreen: (starId: string, channelId: string) =>
    http.delete(`${base(starId)}/planets/${channelId}/screen`),
  stopScreenOf: (starId: string, channelId: string, userId: string) =>
    http.post(`${base(starId)}/planets/${channelId}/voice/${userId}/screen/stop`),
};

/** Ссылка-приглашение, которую можно отправить человеку. */
export function inviteLink(code: string): string {
  return `${window.location.origin}/invite/${code}`;
}

/** Код из ссылки или сам код, если вставили только его. */
export function parseInviteCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{6,32}$/.test(trimmed) ? trimmed : null;
}

const PENDING_INVITE_KEY = "quazar_pending_star_invite";

/** Ссылка /invite/<код> открыта до входа в аккаунт — запоминаем код до входа. */
export function capturePendingInvite(): void {
  const match = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) return;
  try {
    localStorage.setItem(PENDING_INVITE_KEY, match[1]);
  } catch {
    // ignore
  }
  window.history.replaceState({}, "", "/");
}

export function takePendingInvite(): string | null {
  try {
    const code = localStorage.getItem(PENDING_INVITE_KEY);
    if (code) localStorage.removeItem(PENDING_INVITE_KEY);
    return code;
  } catch {
    return null;
  }
}
