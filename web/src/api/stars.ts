import { http } from "./client";

export type StarKind = "gaming" | "work";
export type StarRole = "owner" | "admin" | "moderator" | "member";
export type ChannelKind = "satellite" | "planet";
export type RoomKind = "coworking" | "meeting" | "smoking" | "kitchen" | "custom";
export type StarPerm =
  | "invite"
  | "delete_messages"
  | "kick"
  | "manage_channels"
  | "voice_moderate"
  | "edit_map";

export interface StarUser {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface StarMember {
  user: StarUser;
  role: StarRole;
  joined_at: string;
}

export interface StarChannel {
  id: string;
  star_id: string;
  kind: ChannelKind;
  name: string;
  position: number;
  capacity: number | null;
  room_kind: RoomKind | null;
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
  created_at: string;
  member_count: number;
  my_role: StarRole;
}

export interface RolePermissions {
  moderator: StarPerm[];
  member: StarPerm[];
}

export interface StarDetail extends StarSummary {
  my_permissions: StarPerm[];
  role_permissions: RolePermissions;
  channels: StarChannel[];
  members: StarMember[];
}

export interface StarMessage {
  id: string;
  star_id: string;
  channel_id: string;
  sender: StarUser | null;
  text: string;
  created_at: string;
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
  | { type: "star_updated"; star_id: string; name: string; owner_id: string }
  | { type: "star_removed"; star_id: string; reason: "kick" | "ban" | "leave" | "deleted" }
  | { type: "star_member_upsert"; star_id: string; member: StarMember }
  | { type: "star_member_removed"; star_id: string; user_id: string; reason: string }
  | { type: "star_permissions"; star_id: string; role_permissions: RolePermissions }
  | { type: "star_channel_upsert"; star_id: string; channel: StarChannel }
  | { type: "star_channel_deleted"; star_id: string; channel_id: string }
  | { type: "star_channels_order"; star_id: string; channel_ids: string[] }
  | { type: "star_message"; star_id: string; message: StarMessage }
  | {
      type: "star_message_deleted";
      star_id: string;
      channel_id: string;
      message_id: string;
    };

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
    body: { kind: ChannelKind; name: string; capacity?: number; room_kind?: RoomKind }
  ) => http.post<StarChannel>(`${base(starId)}/channels`, body).then((r) => r.data),
  updateChannel: (
    starId: string,
    channelId: string,
    body: { name?: string; capacity?: number; room_kind?: RoomKind }
  ) => http.patch<StarChannel>(`${base(starId)}/channels/${channelId}`, body).then((r) => r.data),
  deleteChannel: (starId: string, channelId: string) =>
    http.delete(`${base(starId)}/channels/${channelId}`),

  messages: (starId: string, channelId: string, beforeId?: string) =>
    http
      .get<StarMessage[]>(`${base(starId)}/channels/${channelId}/messages`, {
        params: beforeId ? { before_id: beforeId } : {},
      })
      .then((r) => r.data),
  send: (starId: string, channelId: string, text: string) =>
    http
      .post<StarMessage>(`${base(starId)}/channels/${channelId}/messages`, { text })
      .then((r) => r.data),
  deleteMessage: (starId: string, channelId: string, messageId: string) =>
    http.delete(`${base(starId)}/channels/${channelId}/messages/${messageId}`),
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
