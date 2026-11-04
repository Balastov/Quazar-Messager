import { socket } from "../ws/socket";
import type { Message } from "../api/types";

const STATUS_RANK: Record<Message["status"], number> = {
  sent: 0,
  delivered: 1,
  read: 2,
};

export function statusRank(status: string): number {
  return STATUS_RANK[status as Message["status"]] ?? -1;
}

/** Incoming messages that still need an upgrade to `status`. */
export function pickAckIds(
  messages: Message[],
  myId: string,
  status: "delivered" | "read",
  group = false,
): string[] {
  const target = STATUS_RANK[status];
  return messages
    .filter((m) => m.sender_id && m.sender_id !== myId)
    .filter((m) => group && status === "read" ? !m.read_by_me : statusRank(m.status) < target)
    .map((m) => m.id);
}

export function sendMessageStatus(messageIds: string[], status: "delivered" | "read") {
  if (!messageIds.length) return;
  for (let index = 0; index < messageIds.length; index += 250) {
    socket.send({ type: "message_status", message_ids: messageIds.slice(index, index + 250), status });
  }
}

export function applyReadAck(messages: Record<string, Message[]>, messageIds: string[]): Record<string, Message[]> {
  const ids = new Set(messageIds);
  let changed = false;
  const next: Record<string, Message[]> = {};
  for (const [chatId, list] of Object.entries(messages)) {
    let chatChanged = false;
    const updated = list.map(message => {
      if (!ids.has(message.id) || message.read_by_me) return message;
      changed = chatChanged = true;
      return { ...message, read_by_me: true };
    });
    next[chatId] = chatChanged ? updated : list;
  }
  return changed ? next : messages;
}

export function applyLocalStatus(
  messages: Record<string, Message[]>,
  messageIds: string[],
  status: Message["status"]
): Record<string, Message[]> {
  if (!messageIds.length) return messages;
  const idSet = new Set(messageIds);
  const target = statusRank(status);
  const updated: Record<string, Message[]> = {};
  let changed = false;

  for (const [chatId, msgs] of Object.entries(messages)) {
    let chatChanged = false;
    const next = msgs.map((m) => {
      if (!idSet.has(m.id) || statusRank(m.status) >= target) return m;
      chatChanged = true;
      return { ...m, status };
    });
    updated[chatId] = chatChanged ? next : msgs;
    if (chatChanged) changed = true;
  }

  return changed ? updated : messages;
}
