export interface User {
  id: string;
  /** Никнейм латиницей — для @упоминаний и поиска. */
  username: string;
  /** null — скрыт: человек не разрешил находить себя по номеру. Свой виден всегда. */
  phone: string | null;
  first_name?: string | null;
  last_name?: string | null;
  /** «Имя Фамилия» или никнейм, если имя не указано. */
  display_name?: string;
  /** Только у себя (GET /users/me). */
  email?: string | null;
  /** Только у себя: можно ли найти по номеру; null — ещё не выбирал (спросим окном). */
  phone_discoverable?: boolean | null;
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
  /** saved — «Записная книжка», чат с самим собой. */
  // support — чат с Quazar_Admin_bot (обратная связь), без E2E.
  type: 'direct' | 'group' | 'saved' | 'support';
  name: string | null;
  created_at: string;
  /** Последнее сообщение / звонок / создание чата. */
  last_activity_at?: string | null;
  /** Общий фон: «IMG1:{…}», в личных чатах — зашифрованный ENC2 (как в web). */
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
  status: 'sent' | 'delivered' | 'read';
  created_at: string;
  edited_at?: string | null;
  /** Исчезающее сообщение: когда пропадёт у всех. */
  expires_at?: string | null;
  reply_to?: MessageReply | null;
  reactions?: MessageReaction[];
  /** Только в сторе: переслано — от кого (из зашифрованной обёртки «FWD1:»). */
  forwarded_from?: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
}

export type CallMedia = {
  audio: boolean;
  video: boolean;
};

export type CallPhase =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'active'
  | 'ended';

export interface IceServer {
  urls: string[] | string;
  username?: string | null;
  credential?: string | null;
}

export interface CallHistoryItem {
  id: string;
  chat_id: string;
  caller_id: string | null;
  callee_id: string | null;
  media: 'audio' | 'video' | 'audio_video';
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
}

export type SessionDescriptionInit = {
  type?: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
};

export type IceCandidateInit = {
  candidate?: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
};

export type WsEvent =
  | {
      type: 'new_message';
      message_id: string;
      chat_id: string;
      sender_id: string;
      payload: string;
      status: string;
      timestamp: string;
      reply_to?: MessageReply | null;
      expires_at?: string | null;
    }
  | {type: 'chat_ttl'; chat_id: string; ttl_seconds: number | null; changed_by: string}
  | {type: 'message_edited'; chat_id: string; message_id: string; payload: string; edited_at: string}
  /** Удалили у всех — или я сам «удалил у меня» на другом устройстве. */
  | {type: 'message_deleted'; chat_id: string; message_id: string}
  /** payload null — реакцию сняли. В личных чатах payload зашифрован. */
  | {type: 'message_reaction'; chat_id: string; message_id: string; user_id: string; payload: string | null}
  | {type: 'typing'; chat_id: string; user_id: string}
  | {type: 'message_status'; message_id: string; status: string; updated_by: string}
  | {type: 'key_changed'; user_id: string; public_key: string; updated_at: string}
  | {type: 'chat_background'; chat_id: string; background: string | null; changed_by: string}
  | {
      type: 'call_invite';
      call_id: string;
      chat_id: string;
      caller_id: string;
      callee_id: string;
      media: CallMedia;
    }
  | {
      type: 'call_ringing';
      call_id: string;
      chat_id: string;
      callee_id: string;
      media: CallMedia;
    }
  | {
      type: 'call_accept';
      call_id: string;
      chat_id: string;
      accepted_by: string;
    }
  | {
      type: 'call_reject';
      call_id: string;
      chat_id: string;
      rejected_by: string;
      reason?: string;
    }
  | {
      type: 'call_hangup';
      call_id: string;
      chat_id: string;
      ended_by: string;
      reason?: string;
    }
  | {
      type: 'call_offer';
      call_id: string;
      sdp: SessionDescriptionInit;
      from_user_id: string;
    }
  | {
      type: 'call_answer';
      call_id: string;
      sdp: SessionDescriptionInit;
      from_user_id: string;
    }
  | {
      type: 'call_ice';
      call_id: string;
      candidate: IceCandidateInit | null;
      from_user_id: string;
    }
  | {
      type: 'call_unavailable';
      call_id: string;
      chat_id: string;
      callee_id: string;
      reason?: string;
    }
  | {
      type: 'call_busy';
      call_id: string;
      chat_id: string;
      callee_id: string;
    }
  | {type: 'call_error'; error: string; call_id?: string; detail?: string};
