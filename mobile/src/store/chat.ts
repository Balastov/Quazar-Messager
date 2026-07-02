import {create} from 'zustand';
import {chatsApi} from '../api/chats';
import {messagesApi} from '../api/messages';
import {socket} from '../ws/socket';
import {fetchUserPublicKey, loadOrCreateKeys} from '../crypto/keys';
import {decryptMessage, encryptMessage, isEncrypted} from '../crypto/message';
import {useAuthStore} from './auth';
import type {Chat, Message} from '../api/types';

interface ChatState {
  chats: Chat[];
  activeChatId: string | null;
  /** Сообщения уже расшифрованы. */
  messages: Record<string, Message[]>;
  loadingMessages: boolean;
  loadChats: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, plaintext: string) => Promise<void>;
  openDirectChat: (userId: string) => Promise<string>;
}

async function tryDecrypt(payload: string, myPrivKey: string): Promise<string> {
  if (!isEncrypted(payload)) {return payload;}
  return (await decryptMessage(payload, myPrivKey)) ?? '[не удалось расшифровать]';
}

function getOtherUserId(chat: Chat, myId: string): string | null {
  if (chat.type !== 'direct') {return null;}
  return chat.members.find(m => m.user.id !== myId)?.user.id ?? null;
}

export const useChatStore = create<ChatState>((set, get) => {
  socket.on(async event => {
    if (event.type === 'new_message') {
      const {privateKey} = await loadOrCreateKeys();
      const decryptedPayload = await tryDecrypt(event.payload, privateKey);

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
      }));
      if (!get().chats.find(c => c.id === event.chat_id)) {
        get().loadChats();
      }
    }

    if (event.type === 'message_status') {
      set(s => {
        const updated: Record<string, Message[]> = {};
        for (const [chatId, msgs] of Object.entries(s.messages)) {
          updated[chatId] = msgs.map(m =>
            m.id === event.message_id
              ? {...m, status: event.status as Message['status']}
              : m,
          );
        }
        return {messages: updated};
      });
    }
  });

  return {
    chats: [],
    activeChatId: null,
    messages: {},
    loadingMessages: false,

    loadChats: async () => {
      const chats = await chatsApi.list();
      set({chats});
    },

    selectChat: async (chatId: string) => {
      set({activeChatId: chatId, loadingMessages: true});
      if (!get().messages[chatId]) {
        const rawMsgs = await messagesApi.list(chatId);
        const {privateKey} = await loadOrCreateKeys();
        const decrypted = await Promise.all(
          rawMsgs.map(async m => ({
            ...m,
            payload: await tryDecrypt(m.payload, privateKey),
          })),
        );
        set(s => ({messages: {...s.messages, [chatId]: decrypted}}));
      }
      set({loadingMessages: false});
    },

    sendMessage: async (chatId: string, plaintext: string) => {
      const {chats} = get();
      const chat = chats.find(c => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;

      let payload = plaintext;

      if (chat && myId) {
        const otherUserId = getOtherUserId(chat, myId);
        if (otherUserId) {
          const recipientKey = await fetchUserPublicKey(otherUserId);
          if (recipientKey) {
            payload = await encryptMessage(plaintext, recipientKey);
          }
        }
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
