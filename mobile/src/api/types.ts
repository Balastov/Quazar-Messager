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
  type: 'direct' | 'group';
  name: string | null;
  created_at: string;
  members: ChatMember[];
}

export interface Message {
  id: string;
  chat_id: string;
  sender_id: string | null;
  payload: string;
  status: 'sent' | 'delivered' | 'read';
  created_at: string;
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
    }
  | {type: 'message_status'; message_id: string; status: string; updated_by: string}
  | {type: 'key_changed'; user_id: string; public_key: string; updated_at: string}
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
