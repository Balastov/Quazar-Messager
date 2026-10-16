import { create } from "zustand";
import { chatsApi } from "../api/chats";
import { messagesApi } from "../api/messages";
import { socket } from "../ws/socket";
import { E2EError } from "../crypto/errors";
import {
  fetchUserPublicKey,
  invalidateKeyCache,
  loadDecryptionKeys,
  loadKeys,
  type DecryptionKey,
} from "../crypto/keys";
import { decryptMessage, encryptMessage, isEncrypted } from "../crypto/message";
import {
  acceptPeerKeyChange,
  markPeerVerified,
  resolvePeerTrust,
  type TrustCheckResult,
  type TrustStatus,
} from "../crypto/trust";
import { notifyIncomingMessage } from "../notifications/notify";
import {
  applyLocalStatus,
  pickAckIds,
  sendMessageStatus,
  statusRank,
} from "../ws/receipts";
import { useAuthStore } from "./auth";
import { useE2EStore } from "./e2e";
import { useUnreadStore } from "./unread";
import type { Chat, Message } from "../api/types";

function isTabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function ackChatMessages(
  get: () => ChatState,
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  chatId: string,
  status: "delivered" | "read"
) {
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return;
  const msgs = get().messages[chatId] ?? [];
  const ids = pickAckIds(msgs, myId, status);
  if (!ids.length) return;
  sendMessageStatus(ids, status);
  set((s) => ({ messages: applyLocalStatus(s.messages, ids, status) }));
}

interface ChatState {
  chats: Chat[];
  activeChatId: string | null;
  messages: Record<string, Message[]>;
  loadingMessages: boolean;
  e2eReady: boolean | null;
  e2eError: string | null;
  e2eTrust: TrustStatus | null;
  peerFingerprint: string | null;
  peerUserId: string | null;
  showE2ePanel: boolean;
  showMigrationNotice: boolean;

  loadChats: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, plaintext: string) => Promise<void>;
  openDirectChat: (userId: string) => Promise<void>;
  dismissMigrationNotice: () => void;
  setShowE2ePanel: (show: boolean) => void;
  verifyActivePeer: () => Promise<void>;
  acceptActivePeerKey: () => Promise<void>;
  refreshE2EStatus: () => Promise<void>;
}

const sentPlaintextById = new Map<string, string>();

const NO_DEVICE_KEY_ERROR =
  "Ключи шифрования на этом устройстве не восстановлены. Восстановите их из резервной копии.";

async function tryDecrypt(payload: string, keys: DecryptionKey[]): Promise<string> {
  if (!isEncrypted(payload)) return payload;
  for (const key of keys) {
    const plain = await decryptMessage(payload, key);
    if (plain !== null) return plain;
  }
  return useE2EStore.getState().status === "needs_restore"
    ? "🔒 Восстановите ключи шифрования, чтобы прочитать сообщение"
    : "🔒 Сообщение зашифровано ключом, которого нет на этом устройстве";
}

/** Ключ устройства, только если он совпадает с ключом аккаунта. */
async function loadAccountKeys() {
  if (useE2EStore.getState().status !== "ready") return null;
  return loadKeys();
}

function lastActivity(chat: Chat): number {
  return Date.parse(chat.last_activity_at ?? chat.created_at);
}

/** Свежие сверху. */
function sortByActivity(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => lastActivity(b) - lastActivity(a));
}

/** Поднимает чат вверх списка после нового сообщения или звонка. */
function touchChat(chats: Chat[], chatId: string, at: string): Chat[] {
  const chat = chats.find((c) => c.id === chatId);
  if (!chat || lastActivity(chat) >= Date.parse(at)) return chats;
  return sortByActivity(
    chats.map((c) => (c.id === chatId ? { ...c, last_activity_at: at } : c))
  );
}

function getOtherUserId(chat: Chat, myId: string): string | null {
  if (chat.type !== "direct") return null;
  return chat.members.find((m) => m.user.id !== myId)?.user.id ?? null;
}

function trustToUi(trust: TrustCheckResult): {
  ready: boolean;
  error: string | null;
} {
  if (trust.status === "missing") {
    return {
      ready: false,
      error: "Собеседник ещё не настроил шифрование. Отправка недоступна.",
    };
  }
  if (trust.status === "changed") {
    return {
      ready: false,
      error:
        "Ключ собеседника изменился. Проверьте код безопасности и подтвердите новый ключ.",
    };
  }
  return { ready: true, error: null };
}

async function checkDirectE2E(
  chat: Chat,
  myId: string
): Promise<{ ready: boolean; error: string | null; trust: TrustCheckResult | null }> {
  let myPublicKey: string;
  try {
    const keys = await loadAccountKeys();
    if (!keys) return { ready: false, error: NO_DEVICE_KEY_ERROR, trust: null };
    myPublicKey = keys.publicKey;
  } catch {
    return {
      ready: false,
      error: "Не удалось загрузить ключи шифрования на этом устройстве",
      trust: null,
    };
  }

  const otherUserId = getOtherUserId(chat, myId);
  if (!otherUserId) {
    return { ready: false, error: "Не удалось определить собеседника", trust: null };
  }

  const trust = await resolvePeerTrust(otherUserId, myPublicKey);
  const ui = trustToUi(trust);
  return { ...ui, trust };
}

export const useChatStore = create<ChatState>((set, get) => {
  socket.on((event) => {
    void (async () => {
      if (event.type === "new_message") {
        const myId = useAuthStore.getState().user?.id;
        let decryptedPayload: string;

        if (myId && event.sender_id === myId && sentPlaintextById.has(event.message_id)) {
          decryptedPayload = sentPlaintextById.get(event.message_id)!;
          sentPlaintextById.delete(event.message_id);
        } else {
          decryptedPayload = await tryDecrypt(event.payload, await loadDecryptionKeys());
        }

        const msg: Message = {
          id: event.message_id,
          chat_id: event.chat_id,
          sender_id: event.sender_id,
          payload: decryptedPayload,
          status: event.status as Message["status"],
          created_at: event.timestamp,
        };

        set((s) => ({
          messages: {
            ...s.messages,
            [event.chat_id]: [...(s.messages[event.chat_id] ?? []), msg],
          },
          chats: touchChat(s.chats, event.chat_id, event.timestamp),
        }));

        if (!get().chats.find((c) => c.id === event.chat_id)) {
          await get().loadChats();
        }

        if (myId && event.sender_id !== myId) {
          const isActiveChat = get().activeChatId === event.chat_id;
          const tabHidden = !isTabVisible();
          if (!isActiveChat || tabHidden) {
            useUnreadStore.getState().bump(event.chat_id);
          }

          const ackStatus =
            isActiveChat && !tabHidden ? ("read" as const) : ("delivered" as const);
          sendMessageStatus([msg.id], ackStatus);
          set((s) => ({
            messages: applyLocalStatus(s.messages, [msg.id], ackStatus),
          }));
          if (ackStatus === "read") {
            useUnreadStore.getState().clear(event.chat_id);
          }

          const chat = get().chats.find((c) => c.id === event.chat_id);
          const sender =
            chat?.members.find((m) => m.user.id === event.sender_id)?.user.username ??
            "Новое сообщение";
          void notifyIncomingMessage({
            title: sender,
            body: decryptedPayload,
            chatId: event.chat_id,
            isActiveChat,
          });
        }
      }

      if (event.type.startsWith("call_") && "chat_id" in event && event.chat_id) {
        const chatId = event.chat_id;
        set((s) => ({ chats: touchChat(s.chats, chatId, new Date().toISOString()) }));
      }

      if (event.type === "message_status") {
        const nextStatus = event.status as Message["status"];
        set((s) => {
          const updated: Record<string, Message[]> = {};
          for (const [chatId, msgs] of Object.entries(s.messages)) {
            updated[chatId] = msgs.map((m) => {
              if (m.id !== event.message_id) return m;
              if (statusRank(nextStatus) <= statusRank(m.status)) return m;
              return { ...m, status: nextStatus };
            });
          }
          return { messages: updated };
        });
      }

      if (event.type === "key_changed") {
        invalidateKeyCache(event.user_id);
        const myId = useAuthStore.getState().user?.id;
        if (myId && event.user_id === myId) {
          // Ключ аккаунта сменили на другом устройстве.
          await useE2EStore.getState().sync(myId);
          return;
        }
        const chat = get().chats.find((c) => c.id === get().activeChatId);
        if (chat && myId && getOtherUserId(chat, myId) === event.user_id) {
          await get().refreshE2EStatus();
        }
      }
    })();
  });

  useE2EStore.subscribe((st, prev) => {
    if (st.status === prev.status) return;
    if (st.status === "ready" || st.status === "needs_restore") {
      // Ключи устройства изменились: перечитываем историю и статус E2E.
      const activeChatId = get().activeChatId;
      set({ messages: {} });
      if (activeChatId) void get().selectChat(activeChatId);
    }
  });

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!isTabVisible()) return;
      const chatId = get().activeChatId;
      if (!chatId) return;
      ackChatMessages(get, set, chatId, "read");
      useUnreadStore.getState().clear(chatId);
    });
  }

  return {
    chats: [],
    activeChatId: null,
    messages: {},
    loadingMessages: false,
    e2eReady: null,
    e2eError: null,
    e2eTrust: null,
    peerFingerprint: null,
    peerUserId: null,
    showE2ePanel: false,
    showMigrationNotice: false,

    dismissMigrationNotice: () => set({ showMigrationNotice: false }),
    setShowE2ePanel: (show) => set({ showE2ePanel: show }),

    refreshE2EStatus: async () => {
      const { activeChatId, chats } = get();
      const myId = useAuthStore.getState().user?.id;
      const chat = chats.find((c) => c.id === activeChatId);
      if (!chat || chat.type !== "direct" || !myId) return;

      const status = await checkDirectE2E(chat, myId);
      const otherUserId = getOtherUserId(chat, myId);
      set({
        e2eReady: status.ready,
        e2eError: status.error,
        e2eTrust: status.trust?.status ?? null,
        peerFingerprint: status.trust?.fingerprint ?? null,
        peerUserId: otherUserId,
      });
    },

    verifyActivePeer: async () => {
      const { peerUserId } = get();
      const myId = useAuthStore.getState().user?.id;
      if (!peerUserId || !myId) return;

      const keys = await loadAccountKeys();
      if (!keys) return;
      await markPeerVerified(peerUserId, keys.publicKey);
      await get().refreshE2EStatus();
    },

    acceptActivePeerKey: async () => {
      const { peerUserId } = get();
      if (!peerUserId) return;

      const keys = await loadAccountKeys();
      if (!keys) return;
      const serverKey = await fetchUserPublicKey(peerUserId);
      if (!serverKey) return;

      await acceptPeerKeyChange(peerUserId, keys.publicKey, serverKey);
      await get().refreshE2EStatus();
    },

    loadChats: async () => {
      const chats = await chatsApi.list();
      set({ chats: sortByActivity(chats) });
    },

    selectChat: async (chatId) => {
      const myId = useAuthStore.getState().user?.id;
      const chat = get().chats.find((c) => c.id === chatId);

      let e2eReady: boolean | null = null;
      let e2eError: string | null = null;
      let e2eTrust: TrustStatus | null = null;
      let peerFingerprint: string | null = null;
      let peerUserId: string | null = null;

      if (chat?.type === "direct" && myId) {
        const status = await checkDirectE2E(chat, myId);
        e2eReady = status.ready;
        e2eError = status.error;
        e2eTrust = status.trust?.status ?? null;
        peerFingerprint = status.trust?.fingerprint ?? null;
        peerUserId = getOtherUserId(chat, myId);
      }

      useUnreadStore.getState().clear(chatId);

      set({
        activeChatId: chatId,
        loadingMessages: true,
        e2eReady,
        e2eError,
        e2eTrust,
        peerFingerprint,
        peerUserId,
        showE2ePanel: false,
      });

      if (!get().messages[chatId]) {
        const rawMsgs = await messagesApi.list(chatId);
        const keys = await loadDecryptionKeys();
        const decrypted = await Promise.all(
          rawMsgs.map(async (m) => ({
            ...m,
            payload: await tryDecrypt(m.payload, keys),
          }))
        );
        set((s) => ({ messages: { ...s.messages, [chatId]: decrypted } }));
      }

      set({ loadingMessages: false });

      // History catch-up: mark received messages delivered, and read if visible.
      ackChatMessages(get, set, chatId, "delivered");
      if (isTabVisible()) {
        ackChatMessages(get, set, chatId, "read");
      }
    },

    sendMessage: async (chatId, plaintext) => {
      const { chats } = get();
      const chat = chats.find((c) => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;

      if (!chat || !myId) return;

      if (chat.type === "direct") {
        let myPublicKey: string;
        try {
          const keys = await loadAccountKeys();
          if (!keys) throw new E2EError("NO_OWN_KEY", NO_DEVICE_KEY_ERROR);
          myPublicKey = keys.publicKey;
        } catch (err) {
          if (err instanceof E2EError) throw err;
          throw new E2EError(
            "NO_OWN_KEY",
            "Не удалось загрузить ключи шифрования на этом устройстве"
          );
        }

        const otherUserId = getOtherUserId(chat, myId);
        if (!otherUserId) {
          throw new E2EError("NO_RECIPIENT_KEY", "Не удалось определить собеседника");
        }

        const trust = await resolvePeerTrust(otherUserId, myPublicKey);
        if (trust.status === "missing") {
          throw new E2EError(
            "NO_RECIPIENT_KEY",
            "Собеседник ещё не настроил шифрование. Отправка недоступна."
          );
        }
        if (trust.status === "changed") {
          throw new E2EError(
            "KEY_CHANGED",
            "Ключ собеседника изменился. Подтвердите новый ключ перед отправкой."
          );
        }

        const payload = encryptMessage(plaintext, trust.publicKey!, myPublicKey);
        const msg = await messagesApi.send(chatId, payload);
        // Мгновенный echo по WS; история читается через ENC2 self-box.
        sentPlaintextById.set(msg.id, plaintext);
        return;
      }

      await messagesApi.send(chatId, plaintext);
    },

    openDirectChat: async (userId) => {
      const chat = await chatsApi.createDirect(userId);
      set((s) => ({
        chats: s.chats.find((c) => c.id === chat.id) ? s.chats : [chat, ...s.chats],
      }));
      await get().selectChat(chat.id);
    },
  };
});
