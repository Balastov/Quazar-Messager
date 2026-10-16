import {create} from 'zustand';
import {AppState} from 'react-native';
import {chatsApi} from '../api/chats';
import {messagesApi} from '../api/messages';
import {socket} from '../ws/socket';
import {
  applyLocalStatus,
  pickAckIds,
  sendMessageStatus,
  statusRank,
} from '../ws/receipts';
import {
  fetchUserPublicKey,
  invalidateKeyCache,
  loadDecryptionKeys,
  loadKeys,
} from '../crypto/keys';
import {decryptMessage, encryptMessage, isEncrypted} from '../crypto/message';
import {useAuthStore} from './auth';
import {useE2EStore} from './e2e';
import type {Chat, Message} from '../api/types';

interface ChatState {
  chats: Chat[];
  activeChatId: string | null;
  /** Сообщения уже расшифрованы. */
  messages: Record<string, Message[]>;
  loadingMessages: boolean;
  loadChats: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  /** Бросает Error с текстом для пользователя, если отправить нельзя. */
  sendMessage: (chatId: string, plaintext: string) => Promise<void>;
  openDirectChat: (userId: string) => Promise<string>;
}

async function tryDecrypt(payload: string, myPrivKeys: string[]): Promise<string> {
  if (!isEncrypted(payload)) {
    return payload;
  }
  const plain = await decryptMessage(payload, myPrivKeys);
  if (plain !== null) {
    return plain;
  }
  return useE2EStore.getState().status === 'needs_restore'
    ? '🔒 Восстановите ключи шифрования, чтобы прочитать сообщение'
    : '🔒 Сообщение зашифровано ключом, которого нет на этом устройстве';
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
  const chat = chats.find(c => c.id === chatId);
  if (!chat || lastActivity(chat) >= Date.parse(at)) {
    return chats;
  }
  return sortByActivity(
    chats.map(c => (c.id === chatId ? {...c, last_activity_at: at} : c)),
  );
}

function getOtherUserId(chat: Chat, myId: string): string | null {
  if (chat.type !== 'direct') {
    return null;
  }
  return chat.members.find(m => m.user.id !== myId)?.user.id ?? null;
}

function ackChatMessages(
  get: () => ChatState,
  set: (
    partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>),
  ) => void,
  chatId: string,
  status: 'delivered' | 'read',
) {
  const myId = useAuthStore.getState().user?.id;
  if (!myId) {
    return;
  }
  const msgs = get().messages[chatId] ?? [];
  const ids = pickAckIds(msgs, myId, status);
  if (!ids.length) {
    return;
  }
  sendMessageStatus(ids, status);
  set(s => ({messages: applyLocalStatus(s.messages, ids, status)}));
}

export const useChatStore = create<ChatState>((set, get) => {
  socket.on(async event => {
    if (event.type === 'new_message') {
      const myId = useAuthStore.getState().user?.id;
      const decryptedPayload = await tryDecrypt(
        event.payload,
        await loadDecryptionKeys(),
      );

      const msg: Message = {
        id: event.message_id,
        chat_id: event.chat_id,
        sender_id: event.sender_id,
        payload: decryptedPayload,
        status: event.status as Message['status'],
        created_at: event.timestamp,
      };
      set(s => ({
        messages: {
          ...s.messages,
          [event.chat_id]: [...(s.messages[event.chat_id] ?? []), msg],
        },
        chats: touchChat(s.chats, event.chat_id, event.timestamp),
      }));
      if (!get().chats.find(c => c.id === event.chat_id)) {
        get().loadChats();
      }

      if (myId && event.sender_id !== myId) {
        const isActiveChat = get().activeChatId === event.chat_id;
        const appActive = AppState.currentState === 'active';
        const ackStatus =
          isActiveChat && appActive ? ('read' as const) : ('delivered' as const);

        sendMessageStatus([msg.id], ackStatus);
        set(s => ({
          messages: applyLocalStatus(s.messages, [msg.id], ackStatus),
        }));
      }
    }

    if (event.type === 'key_changed') {
      invalidateKeyCache(event.user_id);
      const myId = useAuthStore.getState().user?.id;
      if (myId && event.user_id === myId) {
        // Ключ аккаунта сменили на другом устройстве.
        await useE2EStore.getState().sync(myId);
      }
    }

    if (event.type.startsWith('call_') && 'chat_id' in event && event.chat_id) {
      const chatId = event.chat_id;
      set(s => ({chats: touchChat(s.chats, chatId, new Date().toISOString())}));
    }

    if (event.type === 'message_status') {
      const nextStatus = event.status as Message['status'];
      set(s => {
        const updated: Record<string, Message[]> = {};
        for (const [chatId, msgs] of Object.entries(s.messages)) {
          updated[chatId] = msgs.map(m => {
            if (m.id !== event.message_id) {
              return m;
            }
            if (statusRank(nextStatus) <= statusRank(m.status)) {
              return m;
            }
            return {...m, status: nextStatus};
          });
        }
        return {messages: updated};
      });
    }
  });

  useE2EStore.subscribe((st, prev) => {
    if (st.status === prev.status) {
      return;
    }
    if (st.status === 'ready' || st.status === 'needs_restore') {
      // Ключи устройства изменились: перечитываем историю.
      const activeChatId = get().activeChatId;
      set({messages: {}});
      if (activeChatId) {
        void get().selectChat(activeChatId);
      }
    }
  });

  AppState.addEventListener('change', nextState => {
    if (nextState !== 'active') {
      return;
    }
    const chatId = get().activeChatId;
    if (!chatId) {
      return;
    }
    ackChatMessages(get, set, chatId, 'read');
  });

  return {
    chats: [],
    activeChatId: null,
    messages: {},
    loadingMessages: false,

    loadChats: async () => {
      const chats = await chatsApi.list();
      set({chats: sortByActivity(chats)});
    },

    selectChat: async (chatId: string) => {
      set({activeChatId: chatId, loadingMessages: true});
      if (!get().messages[chatId]) {
        const rawMsgs = await messagesApi.list(chatId);
        const keys = await loadDecryptionKeys();
        const decrypted = await Promise.all(
          rawMsgs.map(async m => ({
            ...m,
            payload: await tryDecrypt(m.payload, keys),
          })),
        );
        set(s => ({messages: {...s.messages, [chatId]: decrypted}}));
      }
      set({loadingMessages: false});

      ackChatMessages(get, set, chatId, 'delivered');
      if (AppState.currentState === 'active') {
        ackChatMessages(get, set, chatId, 'read');
      }
    },

    sendMessage: async (chatId: string, plaintext: string) => {
      const {chats} = get();
      const chat = chats.find(c => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;

      if (!chat || !myId) {
        return;
      }

      let payload = plaintext;

      // Личные чаты — только E2E: без ключей не отправляем, а не шлём открытым текстом.
      if (chat.type === 'direct') {
        const otherUserId = getOtherUserId(chat, myId);
        if (!otherUserId) {
          throw new Error('Не удалось определить собеседника');
        }
        const myKeys =
          useE2EStore.getState().status === 'ready' ? await loadKeys() : null;
        if (!myKeys) {
          throw new Error(
            'Ключи шифрования на этом устройстве не восстановлены. Восстановите их из резервной копии.',
          );
        }
        const recipientKey = await fetchUserPublicKey(otherUserId);
        if (!recipientKey) {
          throw new Error('Собеседник ещё не настроил шифрование. Отправка недоступна.');
        }
        payload = await encryptMessage(plaintext, recipientKey, myKeys.publicKey);
      }

      await messagesApi.send(chatId, payload);
    },

    openDirectChat: async (userId: string) => {
      const chat = await chatsApi.createDirect(userId);
      set(s => ({
        chats: s.chats.find(c => c.id === chat.id) ? s.chats : [chat, ...s.chats],
      }));
      await get().selectChat(chat.id);
      return chat.id;
    },
  };
});
