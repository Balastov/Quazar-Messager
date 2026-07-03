export interface User {
  id: string;
  username: string;
  email: string;
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
  type: "direct" | "group";
  name: string | null;
  created_at: string;
  members: ChatMember[];
}

export interface Message {
  id: string;
  chat_id: string;
  sender_id: string | null;
  payload: string;
  status: "sent" | "delivered" | "read";
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
}

// WebSocket events
export type WsEvent =
  | { type: "new_message"; message_id: string; chat_id: string; sender_id: string; payload: string; status: string; timestamp: string }
  | { type: "message_status"; message_id: string; status: string; updated_by: string }
  | { type: "key_changed"; user_id: string; public_key: string; updated_at: string };
