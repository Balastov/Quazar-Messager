import { create } from "zustand";
import { chatsApi } from "../api/chats";
import { messagesApi } from "../api/messages";
import { socket } from "../ws/socket";
import { E2EError } from "../crypto/errors";
import { fetchUserPublicKey, loadOrCreateKeys } from "../crypto/keys";
import { decryptMessage, encryptMessage, isEncrypted } from "../crypto/message";
import { useAuthStore } from "./auth";
import type { Chat, Message } from "../api/types";

interface ChatState {
  chats: Chat[];
  activeChatId: string | null;
  messages: Record<string, Message[]>;
  loadingMessages: boolean;
  /** E2E готовность для активного direct-чата (null = не direct или не проверялось). */
  e2eReady: boolean | null;
  e2eError: string | null;
  showMigrationNotice: boolean;

  loadChats: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, plaintext: string) => Promise<void>;
  openDirectChat: (userId: string) => Promise<void>;
  dismissMigrationNotice: () => void;
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

async function checkDirectE2E(
  chat: Chat,
  myId: string
): Promise<{ ready: boolean; error: string | null }> {
  try {
    await loadOrCreateKeys();
  } catch {
    return { ready: false, error: "Не удалось загрузить ключи шифрования на этом устройстве" };
  }

  const otherUserId = getOtherUserId(chat, myId);
  if (!otherUserId) {
    return { ready: false, error: "Не удалось определить собеседника" };
  }

  const recipientKey = await fetchUserPublicKey(otherUserId);
  if (!recipientKey) {
    return {
      ready: false,
      error: "Собеседник ещё не настроил шифрование. Отправка недоступна.",
    };
  }

  return { ready: true, error: null };
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
  })();
  });

  return {
    chats: [],
    activeChatId: null,
    messages: {},
    loadingMessages: false,
    e2eReady: null,
    e2eError: null,
    showMigrationNotice: false,

    dismissMigrationNotice: () => set({ showMigrationNotice: false }),

    loadChats: async () => {
      const chats = await chatsApi.list();
      set({ chats });
    },

    selectChat: async (chatId) => {
      const myId = useAuthStore.getState().user?.id;
      const chat = get().chats.find((c) => c.id === chatId);

      let e2eReady: boolean | null = null;
      let e2eError: string | null = null;

      if (chat?.type === "direct" && myId) {
        const status = await checkDirectE2E(chat, myId);
        e2eReady = status.ready;
        e2eError = status.error;
      }

      set({ activeChatId: chatId, loadingMessages: true, e2eReady, e2eError });

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
        try {
          await loadOrCreateKeys();
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

        const recipientKey = await fetchUserPublicKey(otherUserId);
        if (!recipientKey) {
          throw new E2EError(
            "NO_RECIPIENT_KEY",
            "Собеседник ещё не настроил шифрование. Отправка недоступна."
          );
        }

        const payload = encryptMessage(plaintext, recipientKey);
        const msg = await messagesApi.send(chatId, payload);
        sentPlaintextById.set(msg.id, plaintext);
        return;
      }

      // Групповые чаты — без E2E (пока)
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
