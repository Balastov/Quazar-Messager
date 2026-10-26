import type { StarEvent, WorkSchedule } from "./stars";

export type CallMedia = {
  audio: boolean;
  video: boolean;
};

export type CallPhase =
  | "idle"
  | "outgoing"
  | "incoming"
  | "connecting"
  | "active"
  | "ended";

export interface CallHistoryItem {
  id: string;
  chat_id: string;
  caller_id: string | null;
  callee_id: string | null;
  media: "audio" | "video" | "audio_video";
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
}

export interface IceServer {
  urls: string[] | string;
  username?: string | null;
  credential?: string | null;
}

// WebSocket events
export type WsEvent =
  | StarEvent
  | {
      type: "new_message";
      message_id: string;
      chat_id: string;
      sender_id: string;
      payload: string;
      status: string;
      timestamp: string;
      reply_to?: MessageReply | null;
      expires_at?: string | null;
    }
  | { type: "message_edited"; chat_id: string; message_id: string; payload: string; edited_at: string }
  /** Удалили у всех — или я сам «удалил у меня» на другом устройстве. */
  | { type: "message_deleted"; chat_id: string; message_id: string }
  /** payload null — реакцию сняли. В личных чатах payload зашифрован. */
  | { type: "message_reaction"; chat_id: string; message_id: string; user_id: string; payload: string | null }
  | { type: "typing"; chat_id: string; user_id: string }
  | { type: "message_status"; message_id: string; status: string; updated_by: string }
  | { type: "key_changed"; user_id: string; public_key: string; updated_at: string }
  | {
      type: "call_invite";
      call_id: string;
      chat_id: string;
      caller_id: string;
      callee_id: string;
      media: CallMedia;
    }
  | {
      type: "call_ringing";
      call_id: string;
      chat_id: string;
      callee_id: string;
      media: CallMedia;
    }
  | {
      type: "call_accept";
      call_id: string;
      chat_id: string;
      accepted_by: string;
    }
  | {
      type: "call_reject";
      call_id: string;
      chat_id: string;
      rejected_by: string;
      reason?: string;
    }
  | {
      type: "call_hangup";
      call_id: string;
      chat_id: string;
      ended_by: string;
      reason?: string;
    }
  | { type: "call_offer"; call_id: string; sdp: RTCSessionDescriptionInit; from_user_id: string }
  | { type: "call_answer"; call_id: string; sdp: RTCSessionDescriptionInit; from_user_id: string }
  | {
      type: "call_ice";
      call_id: string;
      candidate: RTCIceCandidateInit | null;
      from_user_id: string;
    }
  | {
      type: "call_unavailable";
      call_id: string;
      chat_id: string;
      callee_id: string;
      reason?: string;
    }
  | {
      type: "call_busy";
      call_id: string;
      chat_id: string;
      callee_id: string;
    }
  | { type: "call_error"; error: string; call_id?: string; detail?: string }
  /** Собеседник потерял связь с сервером / вернулся. */
  | { type: "call_reconnecting"; call_id: string; user_id: string }
  | { type: "call_reconnected"; call_id: string; user_id: string }
  /** Ответ на call_resume после переподключения. */
  | { type: "call_resumed"; call_id: string }
  | { type: "call_resume_failed"; call_id: string }
  /** Личный фон приложения сменили (в том числе на другом устройстве). */
  | { type: "user_background"; background_url: string | null }
  /** Общий фон чата сменил кто-то из участников. */
  | { type: "chat_background"; chat_id: string; background: string | null; changed_by: string }
  /** Исчезающие сообщения включили / выключили / поменяли срок. */
  | { type: "chat_ttl"; chat_id: string; ttl_seconds: number | null; changed_by: string }
  /** Я заблокировал или разблокировал кого-то (в том числе на другом устройстве). */
  | { type: "blocks_changed"; user_id: string; blocked: boolean }
  /** Мои отложенные сообщения в чате изменились (запланировал, отменил, отправилось). */
  | { type: "scheduled_changed"; chat_id: string }
  /** Пора напомнить о сообщении. */
  | { type: "reminder"; reminder_id: string; chat_id: string; message_id: string }
  /** Собеседник по звонку включил/выключил камеру или показ экрана. */
  | { type: "call_media"; call_id: string; video: boolean; screen: boolean; from_user_id: string }
  /** Мой рабочий график сменили (в том числе на другом устройстве). */
  | { type: "my_work_schedule"; schedule: WorkSchedule | null }
  /** Закреплённые в чате изменились. */
  | { type: "chat_pins"; chat_id: string; message_ids: string[] }
  /** Мой уровень уведомлений сменили (в том числе на другом устройстве). */
  | {
      type: "notify_setting";
      scope: "chat" | "star" | "channel";
      target_id: string;
      level: "all" | "mentions" | "none" | null;
      muted_until: string | null;
    }
  | { type: "pong" };

// Re-export existing domain types from the previous types file content
export interface User {
  id: string;
  username: string;
  phone: string;
  avatar_url: string | null;
  created_at: string;
}

export interface ChatMember {
  user: User;
  role: string;
  joined_at: string;
}

export interface Chat {
  id: string;
  /** saved — «Избранное», чат с самим собой. */
  type: "direct" | "group" | "saved";
  name: string | null;
  created_at: string;
  /** Последнее сообщение / звонок / создание чата. */
  last_activity_at?: string | null;
  /** Общий фон: «IMG1:{…}», в личных чатах — зашифрованный ENC2. null — фон приложения. */
  background?: string | null;
  /** Исчезающие сообщения: сколько секунд живёт новое (null — не исчезают). */
  ttl_seconds?: number | null;
  members: ChatMember[];
}

/** Цитата в ответе. В сторе payload уже расшифрован. */
export interface MessageReply {
  id: string;
  sender_id: string | null;
  payload: string;
}

/** Реакция участника. В сторе payload — уже расшифрованный эмодзи. */
export interface MessageReaction {
  user_id: string;
  payload: string;
}

export interface Message {
  id: string;
  chat_id: string;
  sender_id: string | null;
  payload: string;
  status: "sent" | "delivered" | "read";
  created_at: string;
  edited_at?: string | null;
  /** Исчезающее сообщение: когда пропадёт у всех. */
  expires_at?: string | null;
  reply_to?: MessageReply | null;
  reactions?: MessageReaction[];
  /** Только в сторе: сообщение переслано — от кого (из зашифрованной обёртки «FWD1:»). */
  forwarded_from?: string | null;
  /** Превью первой ссылки (собрал отправитель, пришло внутри сообщения). */
  link_preview?: import("../chat/linkPreview").LinkPreview | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
}
