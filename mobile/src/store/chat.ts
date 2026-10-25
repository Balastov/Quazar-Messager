import {create} from 'zustand';
import {AppState} from 'react-native';
import {chatsApi} from '../api/chats';
import {messagesApi} from '../api/messages';
import {attachmentsApi} from '../api/attachments';
import {
  encodeImage,
  encryptFile,
  parseImage,
  readPickedImage,
  type ImageRef,
} from '../attachments/image';
import {seedImageUri} from '../attachments/cache';
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
import {applyReaction} from '../chat/reactions';
import type {Chat, Message, MessageReaction} from '../api/types';

/** Пока человек набирает, сообщаем серверу не чаще этого. */
const TYPING_SEND_EVERY_MS = 3000;
/** «печатает…» гаснет, если от человека столько времени ничего не приходило. */
const TYPING_SHOW_MS = 6000;

export interface PickedImage {
  base64: string;
  width: number;
  height: number;
}

interface ChatState {
  chats: Chat[];
  activeChatId: string | null;
  /** Сообщения уже расшифрованы. */
  messages: Record<string, Message[]>;
  /** Общие фоны чатов, уже расшифрованные: chatId → картинка. */
  backgrounds: Record<string, ImageRef>;
  loadingMessages: boolean;
  /** Кто сейчас печатает: chatId → userId. */
  typing: Record<string, string[]>;
  loadChats: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  /** Бросает Error с текстом для пользователя, если отправить нельзя. */
  sendMessage: (
    chatId: string,
    plaintext: string,
    attachmentId?: string,
    replyToId?: string,
  ) => Promise<void>;
  /** Картинка из галереи; бросает Error с текстом для пользователя. */
  sendImage: (chatId: string, image: PickedImage, replyToId?: string) => Promise<void>;
  /** Исправить свой текст; в личных чатах — зашифровать заново. */
  editMessage: (chatId: string, messageId: string, plaintext: string) => Promise<void>;
  /** Удалить у всех. */
  deleteMessage: (chatId: string, messageId: string) => Promise<void>;
  /** Удалить у меня (на всех моих устройствах). */
  hideMessage: (chatId: string, messageId: string) => Promise<void>;
  /** Поставить, сменить (emoji) или снять (null) свою реакцию. */
  react: (chatId: string, messageId: string, emoji: string | null) => Promise<void>;
  /** Я набираю текст — сообщить собеседникам (не чаще раза в 3 с). */
  notifyTyping: (chatId: string) => void;
  openDirectChat: (userId: string) => Promise<string>;
}

const LOCKED_NEEDS_RESTORE = '🔒 Восстановите ключи шифрования, чтобы прочитать сообщение';
const LOCKED_FOREIGN_KEY = '🔒 Сообщение зашифровано ключом, которого нет на этом устройстве';

/** Сообщение не расшифровалось на этом устройстве — его не исправить. */
export function isUnreadable(payload: string): boolean {
  return payload === LOCKED_NEEDS_RESTORE || payload === LOCKED_FOREIGN_KEY;
}

async function openPayload(payload: string, myPrivKeys: string[]): Promise<string | null> {
  if (!isEncrypted(payload)) {
    return payload;
  }
  return decryptMessage(payload, myPrivKeys);
}

async function tryDecrypt(payload: string, myPrivKeys: string[]): Promise<string> {
  const plain = await openPayload(payload, myPrivKeys);
  if (plain !== null) {
    return plain;
  }
  return useE2EStore.getState().status === 'needs_restore'
    ? LOCKED_NEEDS_RESTORE
    : LOCKED_FOREIGN_KEY;
}

/** Реакции, которые не расшифровались, не показываем вовсе. */
async function openReactions(
  reactions: MessageReaction[] | undefined,
  myPrivKeys: string[],
): Promise<MessageReaction[]> {
  const opened = await Promise.all(
    (reactions ?? []).map(async r => {
      const payload = await openPayload(r.payload, myPrivKeys);
      return payload === null ? null : {...r, payload};
    }),
  );
  return opened.filter((r): r is MessageReaction => r !== null);
}

/** Сообщение с сервера — расшифровать вместе с цитатой и реакциями. */
async function openMessage(m: Message, myPrivKeys: string[]): Promise<Message> {
  return {
    ...m,
    payload: await tryDecrypt(m.payload, myPrivKeys),
    reply_to: m.reply_to
      ? {...m.reply_to, payload: await tryDecrypt(m.reply_to.payload, myPrivKeys)}
      : null,
    reactions: await openReactions(m.reactions, myPrivKeys),
  };
}

/** Текст для отправки в чат: в личном — зашифрованный E2E для собеседника и для себя (ENC2). */
async function sealForChat(chat: Chat, myId: string, plaintext: string): Promise<string> {
  // Личные чаты — только E2E: без ключей не отправляем, а не шлём открытым текстом.
  if (chat.type !== 'direct') {
    return plaintext;
  }
  const otherUserId = getOtherUserId(chat, myId);
  if (!otherUserId) {
    throw new Error('Не удалось определить собеседника');
  }
  const myKeys = useE2EStore.getState().status === 'ready' ? await loadKeys() : null;
  if (!myKeys) {
    throw new Error(
      'Ключи шифрования на этом устройстве не восстановлены. Восстановите их из резервной копии.',
    );
  }
  const recipientKey = await fetchUserPublicKey(otherUserId);
  if (!recipientKey) {
    throw new Error('Собеседник ещё не настроил шифрование. Отправка недоступна.');
  }
  return encryptMessage(plaintext, recipientKey, myKeys.publicKey);
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

/** Общий фон чата: расшифровать и разобрать; null — фона нет или его не прочитать. */
async function openBackground(payload: string | null | undefined): Promise<ImageRef | null> {
  if (!payload) {
    return null;
  }
  return parseImage(await tryDecrypt(payload, await loadDecryptionKeys()));
}

export const useChatStore = create<ChatState>((set, get) => {
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const typingSentAt = new Map<string, number>();

  function setTyping(chatId: string, userId: string, on: boolean) {
    const key = `${chatId}|${userId}`;
    clearTimeout(typingTimers.get(key));
    typingTimers.delete(key);
    if (on) {
      typingTimers.set(
        key,
        setTimeout(() => setTyping(chatId, userId, false), TYPING_SHOW_MS),
      );
    }
    set(s => {
      const list = s.typing[chatId] ?? [];
      if (on === list.includes(userId)) {
        return {};
      }
      const next = on ? [...list, userId] : list.filter(id => id !== userId);
      const typing = {...s.typing};
      if (next.length) {
        typing[chatId] = next;
      } else {
        delete typing[chatId];
      }
      return {typing};
    });
  }

  /** Изменить загруженные сообщения чата (не открывали — нечего менять). */
  function updateMessages(chatId: string, fn: (msgs: Message[]) => Message[]) {
    set(s => {
      const msgs = s.messages[chatId];
      return msgs ? {messages: {...s.messages, [chatId]: fn(msgs)}} : {};
    });
  }

  /** Убрать сообщение; ответы на него остаются, но без цитаты — как после перезагрузки. */
  function removeMessage(chatId: string, messageId: string) {
    updateMessages(chatId, msgs =>
      msgs
        .filter(m => m.id !== messageId)
        .map(m => (m.reply_to?.id === messageId ? {...m, reply_to: null} : m)),
    );
  }

  function applyBackground(chatId: string, ref: ImageRef | null) {
    set(s => {
      const backgrounds = {...s.backgrounds};
      if (ref) {
        backgrounds[chatId] = ref;
      } else {
        delete backgrounds[chatId];
      }
      return {backgrounds};
    });
  }

  socket.on(async event => {
    if (event.type === 'chat_background') {
      set(s => ({
        chats: s.chats.map(c =>
          c.id === event.chat_id ? {...c, background: event.background} : c,
        ),
      }));
      applyBackground(event.chat_id, await openBackground(event.background));
    }

    if (event.type === 'typing') {
      setTyping(event.chat_id, event.user_id, true);
    }

    if (event.type === 'message_edited') {
      const payload = await tryDecrypt(event.payload, await loadDecryptionKeys());
      updateMessages(event.chat_id, msgs =>
        msgs.map(m => {
          if (m.id === event.message_id) {
            return {...m, payload, edited_at: event.edited_at};
          }
          if (m.reply_to?.id === event.message_id) {
            return {...m, reply_to: {...m.reply_to, payload}};
          }
          return m;
        }),
      );
    }

    if (event.type === 'message_deleted') {
      removeMessage(event.chat_id, event.message_id);
    }

    if (event.type === 'message_reaction') {
      const payload =
        event.payload === null
          ? null
          : await openPayload(event.payload, await loadDecryptionKeys());
      updateMessages(event.chat_id, msgs =>
        msgs.map(m =>
          m.id === event.message_id
            ? {
                ...m,
                reactions: applyReaction(
                  m.reactions,
                  event.user_id,
                  payload === null ? null : {user_id: event.user_id, payload},
                ),
              }
            : m,
        ),
      );
    }

    if (event.type === 'new_message') {
      const myId = useAuthStore.getState().user?.id;
      const keys = await loadDecryptionKeys();
      const decryptedPayload = await tryDecrypt(event.payload, keys);
      setTyping(event.chat_id, event.sender_id, false);

      const msg: Message = {
        id: event.message_id,
        chat_id: event.chat_id,
        sender_id: event.sender_id,
        payload: decryptedPayload,
        status: event.status as Message['status'],
        created_at: event.timestamp,
        reply_to: event.reply_to
          ? {...event.reply_to, payload: await tryDecrypt(event.reply_to.payload, keys)}
          : null,
        reactions: [],
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
    backgrounds: {},
    loadingMessages: false,
    typing: {},

    loadChats: async () => {
      const chats = await chatsApi.list();
      set({chats: sortByActivity(chats)});
      const backgrounds: Record<string, ImageRef> = {};
      for (const chat of chats) {
        const ref = await openBackground(chat.background);
        if (ref) {
          backgrounds[chat.id] = ref;
        }
      }
      set({backgrounds});
    },

    selectChat: async (chatId: string) => {
      set({activeChatId: chatId, loadingMessages: true});
      if (!get().messages[chatId]) {
        const rawMsgs = await messagesApi.list(chatId);
        const keys = await loadDecryptionKeys();
        const decrypted = await Promise.all(rawMsgs.map(m => openMessage(m, keys)));
        set(s => ({messages: {...s.messages, [chatId]: decrypted}}));
      }
      set({loadingMessages: false});

      ackChatMessages(get, set, chatId, 'delivered');
      if (AppState.currentState === 'active') {
        ackChatMessages(get, set, chatId, 'read');
      }
    },

    sendMessage: async (chatId, plaintext, attachmentId, replyToId) => {
      const chat = get().chats.find(c => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) {
        return;
      }
      const payload = await sealForChat(chat, myId, plaintext);
      typingSentAt.delete(chatId);
      await messagesApi.send(chatId, payload, attachmentId, replyToId);
    },

    sendImage: async (chatId: string, image: PickedImage, replyToId?: string) => {
      const {bytes, mime} = await readPickedImage(image.base64);
      const {blob, key} = await encryptFile(bytes);
      const {id} = await attachmentsApi.upload(chatId, blob);
      seedImageUri(id, image.base64, mime);
      await get().sendMessage(
        chatId,
        encodeImage({id, key, mime, w: image.width, h: image.height, size: bytes.length}),
        id,
        replyToId,
      );
    },

    editMessage: async (chatId, messageId, plaintext) => {
      const chat = get().chats.find(c => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) {
        return;
      }
      const payload = await sealForChat(chat, myId, plaintext);
      const out = await messagesApi.edit(chatId, messageId, payload);
      updateMessages(chatId, msgs =>
        msgs.map(m => {
          if (m.id === messageId) {
            return {...m, payload: plaintext, edited_at: out.edited_at};
          }
          if (m.reply_to?.id === messageId) {
            return {...m, reply_to: {...m.reply_to, payload: plaintext}};
          }
          return m;
        }),
      );
    },

    deleteMessage: async (chatId, messageId) => {
      await messagesApi.remove(chatId, messageId);
      removeMessage(chatId, messageId);
    },

    hideMessage: async (chatId, messageId) => {
      await messagesApi.hide(chatId, messageId);
      removeMessage(chatId, messageId);
    },

    react: async (chatId, messageId, emoji) => {
      const chat = get().chats.find(c => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) {
        return;
      }
      if (emoji === null) {
        await messagesApi.unreact(chatId, messageId);
      } else {
        // В личном чате эмодзи шифруется, как сообщение: сервер не видит, что поставили.
        await messagesApi.react(chatId, messageId, await sealForChat(chat, myId, emoji));
      }
      updateMessages(chatId, msgs =>
        msgs.map(m =>
          m.id === messageId
            ? {
                ...m,
                reactions: applyReaction(
                  m.reactions,
                  myId,
                  emoji === null ? null : {user_id: myId, payload: emoji},
                ),
              }
            : m,
        ),
      );
    },

    notifyTyping: chatId => {
      const now = Date.now();
      if (now - (typingSentAt.get(chatId) ?? 0) < TYPING_SEND_EVERY_MS) {
        return;
      }
      typingSentAt.set(chatId, now);
      socket.send({type: 'typing', chat_id: chatId});
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
