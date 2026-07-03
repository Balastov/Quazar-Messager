import { create } from "zustand";
import { chatsApi } from "../api/chats";
import { messagesApi } from "../api/messages";
import { socket } from "../ws/socket";
import { E2EError } from "../crypto/errors";
import {
  fetchUserPublicKey,
  invalidateKeyCache,
  loadOrCreateKeys,
} from "../crypto/keys";
import { decryptMessage, encryptMessage, isEncrypted } from "../crypto/message";
import {
  acceptPeerKeyChange,
  markPeerVerified,
  resolvePeerTrust,
  type TrustCheckResult,
  type TrustStatus,
} from "../crypto/trust";
import { useAuthStore } from "./auth";
import type { Chat, Message } from "../api/types";

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

async function tryDecrypt(payload: string, privateKey: CryptoKey): Promise<string> {
  if (!isEncrypted(payload)) return payload;
  return (await decryptMessage(payload, privateKey)) ?? "[не удалось расшифровать]";
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
    ({ publicKey: myPublicKey } = await loadOrCreateKeys());
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
          const { privateKey } = await loadOrCreateKeys();
          decryptedPayload = await tryDecrypt(event.payload, privateKey);
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
        }));

        if (!get().chats.find((c) => c.id === event.chat_id)) {
          await get().loadChats();
        }
      }

      if (event.type === "message_status") {
        set((s) => {
          const updated: Record<string, Message[]> = {};
          for (const [chatId, msgs] of Object.entries(s.messages)) {
            updated[chatId] = msgs.map((m) =>
              m.id === event.message_id ? { ...m, status: event.status as Message["status"] } : m
            );
          }
          return { messages: updated };
        });
      }

      if (event.type === "key_changed") {
        invalidateKeyCache(event.user_id);
        const myId = useAuthStore.getState().user?.id;
        const chat = get().chats.find((c) => c.id === get().activeChatId);
        if (chat && myId && getOtherUserId(chat, myId) === event.user_id) {
          await get().refreshE2EStatus();
        }
      }
    })();
  });

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

      const { publicKey } = await loadOrCreateKeys();
      await markPeerVerified(peerUserId, publicKey);
      await get().refreshE2EStatus();
    },

    acceptActivePeerKey: async () => {
      const { peerUserId } = get();
      if (!peerUserId) return;

      const { publicKey } = await loadOrCreateKeys();
      const serverKey = await fetchUserPublicKey(peerUserId);
      if (!serverKey) return;

      await acceptPeerKeyChange(peerUserId, publicKey, serverKey);
      await get().refreshE2EStatus();
    },

    loadChats: async () => {
      const chats = await chatsApi.list();
      set({ chats });
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
        const { privateKey } = await loadOrCreateKeys();
        const decrypted = await Promise.all(
          rawMsgs.map(async (m) => ({
            ...m,
            payload: await tryDecrypt(m.payload, privateKey),
          }))
        );
        set((s) => ({ messages: { ...s.messages, [chatId]: decrypted } }));
      }

      set({ loadingMessages: false });
    },

    sendMessage: async (chatId, plaintext) => {
      const { chats } = get();
      const chat = chats.find((c) => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;

      if (!chat || !myId) return;

      if (chat.type === "direct") {
        let myPublicKey: string;
        try {
          ({ publicKey: myPublicKey } = await loadOrCreateKeys());
        } catch {
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

        const payload = encryptMessage(plaintext, trust.publicKey!);
        const msg = await messagesApi.send(chatId, payload);
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
