import { create } from "zustand";
import { chatsApi } from "../api/chats";
import { messagesApi } from "../api/messages";
import { attachmentsApi } from "../api/attachments";
import {
  AttachmentError,
  detectImageMime,
  encodeImage,
  encryptFile,
  MAX_IMAGE_BYTES,
  parseImage,
  type ImageRef,
} from "../attachments/image";
import { MAX_SOURCE_BYTES, prepareImage } from "../attachments/compress";
import { seedImageUrl, seedVoiceUrl } from "../attachments/cache";
import { encodeVoice } from "../attachments/voice";
import type { Recording } from "../voice/recorder";
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
import { messagePreview } from "./stickers";
import { applyReaction } from "../chat/reactions";
import type { Chat, Message, MessageReaction } from "../api/types";

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
  sendMessage: (
    chatId: string,
    plaintext: string,
    attachmentId?: string,
    replyToId?: string
  ) => Promise<void>;
  /** Бросает AttachmentError (или E2EError) с текстом для пользователя. */
  sendImage: (chatId: string, file: File, replyToId?: string) => Promise<void>;
  /** Записанное голосовое: зашифровать, загрузить и отправить. */
  sendVoice: (chatId: string, recording: Recording, replyToId?: string) => Promise<void>;
  /** Исправить свой текст; в личных чатах — зашифровать заново. */
  editMessage: (chatId: string, messageId: string, plaintext: string) => Promise<void>;
  /** Удалить у всех. */
  deleteMessage: (chatId: string, messageId: string) => Promise<void>;
  /** Удалить у меня (на всех моих устройствах). */
  hideMessage: (chatId: string, messageId: string) => Promise<void>;
  /** Поставить, сменить (emoji) или снять (null) свою реакцию. */
  react: (chatId: string, messageId: string, emoji: string | null) => Promise<void>;
  /** Общие фоны чатов, уже расшифрованные: chatId → картинка. Нет ключа — фона нет. */
  backgrounds: Record<string, ImageRef>;
  /** Сменить общий фон чата (null — убрать); собеседник увидит его сразу. */
  setChatBackground: (chatId: string, file: File | null) => Promise<void>;
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

const LOCKED_NEEDS_RESTORE = "🔒 Восстановите ключи шифрования, чтобы прочитать сообщение";
const LOCKED_FOREIGN_KEY = "🔒 Сообщение зашифровано ключом, которого нет на этом устройстве";

/** Сообщение не расшифровалось на этом устройстве — его не исправить и не скопировать. */
export function isUnreadable(payload: string): boolean {
  return payload === LOCKED_NEEDS_RESTORE || payload === LOCKED_FOREIGN_KEY;
}

async function openPayload(payload: string, keys: DecryptionKey[]): Promise<string | null> {
  if (!isEncrypted(payload)) return payload;
  for (const key of keys) {
    const plain = await decryptMessage(payload, key);
    if (plain !== null) return plain;
  }
  return null;
}

async function tryDecrypt(payload: string, keys: DecryptionKey[]): Promise<string> {
  const plain = await openPayload(payload, keys);
  if (plain !== null) return plain;
  return useE2EStore.getState().status === "needs_restore"
    ? LOCKED_NEEDS_RESTORE
    : LOCKED_FOREIGN_KEY;
}

/** Реакции, которые не расшифровались, не показываем вовсе. */
async function openReactions(
  reactions: MessageReaction[] | undefined,
  keys: DecryptionKey[]
): Promise<MessageReaction[]> {
  const opened = await Promise.all(
    (reactions ?? []).map(async (r) => {
      const payload = await openPayload(r.payload, keys);
      return payload === null ? null : { ...r, payload };
    })
  );
  return opened.filter((r): r is MessageReaction => r !== null);
}

/** Сообщение с сервера — расшифровать вместе с цитатой и реакциями. */
async function openMessage(m: Message, keys: DecryptionKey[]): Promise<Message> {
  return {
    ...m,
    payload: await tryDecrypt(m.payload, keys),
    reply_to: m.reply_to
      ? { ...m.reply_to, payload: await tryDecrypt(m.reply_to.payload, keys) }
      : null,
    reactions: await openReactions(m.reactions, keys),
  };
}

/** Ключ устройства, только если он совпадает с ключом аккаунта. */
async function loadAccountKeys() {
  if (useE2EStore.getState().status !== "ready") return null;
  return loadKeys();
}

/** Текст для отправки в чат: в личном — зашифрованный E2E для собеседника и для себя (ENC2). */
async function sealForChat(chat: Chat, myId: string, plaintext: string): Promise<string> {
  if (chat.type !== "direct") return plaintext;

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

  return encryptMessage(plaintext, trust.publicKey!, myPublicKey);
}

/** Картинку — уменьшить, зашифровать и загрузить во вложения чата. */
async function uploadChatImage(chatId: string, file: File): Promise<ImageRef> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new AttachmentError("Файл больше 50 МБ — такую картинку не отправить");
  }
  const source = new Uint8Array(await file.arrayBuffer());
  const sourceMime = detectImageMime(source);
  if (!sourceMime) {
    throw new AttachmentError("Можно отправлять только картинки: JPEG, PNG, GIF или WebP");
  }
  // Уменьшаем до 2560 px и пережимаем в JPEG; на сервер уходит уже это.
  const { bytes, mime, w, h } = await prepareImage(source, sourceMime);

  const { blob, key } = encryptFile(bytes);
  const { id } = await attachmentsApi.upload(chatId, blob);
  seedImageUrl(id, bytes, mime);
  return { id, key, mime, w, h, size: bytes.length };
}

/** Общий фон чата: расшифровать и разобрать. null — фона нет или его не прочитать. */
async function openBackground(payload: string | null | undefined): Promise<ImageRef | null> {
  if (!payload) return null;
  return parseImage(await tryDecrypt(payload, await loadDecryptionKeys()));
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
  /** Запомнить фон чата: payload — как на сервере, ref — расшифрованный. */
  function applyBackground(chatId: string, payload: string | null, ref: ImageRef | null) {
    set((s) => {
      const backgrounds = { ...s.backgrounds };
      if (ref) backgrounds[chatId] = ref;
      else delete backgrounds[chatId];
      return {
        backgrounds,
        chats: s.chats.map((c) => (c.id === chatId ? { ...c, background: payload } : c)),
      };
    });
  }

  /** Расшифровать фоны всех чатов (после загрузки списка или смены ключей). */
  async function refreshBackgrounds(chats: Chat[]) {
    const entries = await Promise.all(
      chats.map(async (c) => [c.id, await openBackground(c.background)] as const)
    );
    const backgrounds: Record<string, ImageRef> = {};
    for (const [id, ref] of entries) if (ref) backgrounds[id] = ref;
    set({ backgrounds });
  }

  /** Изменить загруженные сообщения чата (если чат ещё не открывали — нечего менять). */
  function updateMessages(chatId: string, fn: (msgs: Message[]) => Message[]) {
    set((s) => {
      const msgs = s.messages[chatId];
      return msgs ? { messages: { ...s.messages, [chatId]: fn(msgs) } } : {};
    });
  }

  /** Убрать сообщение; ответы на него остаются, но без цитаты — как после перезагрузки. */
  function removeMessage(chatId: string, messageId: string) {
    updateMessages(chatId, (msgs) =>
      msgs
        .filter((m) => m.id !== messageId)
        .map((m) => (m.reply_to?.id === messageId ? { ...m, reply_to: null } : m))
    );
  }

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
          reply_to: event.reply_to
            ? {
                ...event.reply_to,
                payload: await tryDecrypt(event.reply_to.payload, await loadDecryptionKeys()),
              }
            : null,
          reactions: [],
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
            body: messagePreview(decryptedPayload),
            chatId: event.chat_id,
            isActiveChat,
          });
        }
      }

      if (event.type.startsWith("call_") && "chat_id" in event && event.chat_id) {
        const chatId = event.chat_id;
        set((s) => ({ chats: touchChat(s.chats, chatId, new Date().toISOString()) }));
      }

      if (event.type === "message_edited") {
        const payload = await tryDecrypt(event.payload, await loadDecryptionKeys());
        updateMessages(event.chat_id, (msgs) =>
          msgs.map((m) => {
            if (m.id === event.message_id) return { ...m, payload, edited_at: event.edited_at };
            if (m.reply_to?.id === event.message_id) return { ...m, reply_to: { ...m.reply_to, payload } };
            return m;
          })
        );
      }

      if (event.type === "message_deleted") {
        removeMessage(event.chat_id, event.message_id);
      }

      if (event.type === "message_reaction") {
        const payload =
          event.payload === null
            ? null
            : await openPayload(event.payload, await loadDecryptionKeys());
        updateMessages(event.chat_id, (msgs) =>
          msgs.map((m) =>
            m.id === event.message_id
              ? {
                  ...m,
                  reactions: applyReaction(
                    m.reactions,
                    event.user_id,
                    payload === null ? null : { user_id: event.user_id, payload }
                  ),
                }
              : m
          )
        );
      }

      if (event.type === "chat_background") {
        applyBackground(event.chat_id, event.background, await openBackground(event.background));
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
      void refreshBackgrounds(get().chats);
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
    backgrounds: {},
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
      await refreshBackgrounds(chats);
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
        const decrypted = await Promise.all(rawMsgs.map((m) => openMessage(m, keys)));
        set((s) => ({ messages: { ...s.messages, [chatId]: decrypted } }));
      }

      set({ loadingMessages: false });

      // History catch-up: mark received messages delivered, and read if visible.
      ackChatMessages(get, set, chatId, "delivered");
      if (isTabVisible()) {
        ackChatMessages(get, set, chatId, "read");
      }
    },

    sendMessage: async (chatId, plaintext, attachmentId, replyToId) => {
      const chat = get().chats.find((c) => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) return;

      const payload = await sealForChat(chat, myId, plaintext);
      const msg = await messagesApi.send(chatId, payload, attachmentId, replyToId);
      // Мгновенный echo по WS; история читается через ENC2 self-box.
      if (payload !== plaintext) sentPlaintextById.set(msg.id, plaintext);
    },

    sendImage: async (chatId, file, replyToId) => {
      const ref = await uploadChatImage(chatId, file);
      await get().sendMessage(chatId, encodeImage(ref), ref.id, replyToId);
    },

    sendVoice: async (chatId, recording, replyToId) => {
      if (recording.bytes.length > MAX_IMAGE_BYTES) {
        throw new AttachmentError("Голосовое больше 10 МБ — такое не отправить");
      }
      const { blob, key } = encryptFile(recording.bytes);
      const { id } = await attachmentsApi.upload(chatId, blob);
      seedVoiceUrl(id, recording.bytes, recording.mime);
      const payload = encodeVoice({
        id,
        key,
        mime: recording.mime,
        dur: recording.dur,
        size: recording.bytes.length,
        wave: recording.wave,
      });
      await get().sendMessage(chatId, payload, id, replyToId);
    },

    editMessage: async (chatId, messageId, plaintext) => {
      const chat = get().chats.find((c) => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) return;

      const payload = await sealForChat(chat, myId, plaintext);
      const out = await messagesApi.edit(chatId, messageId, payload);
      updateMessages(chatId, (msgs) =>
        msgs.map((m) => {
          if (m.id === messageId) return { ...m, payload: plaintext, edited_at: out.edited_at };
          if (m.reply_to?.id === messageId) return { ...m, reply_to: { ...m.reply_to, payload: plaintext } };
          return m;
        })
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
      const chat = get().chats.find((c) => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) return;

      if (emoji === null) {
        await messagesApi.unreact(chatId, messageId);
      } else {
        // В личном чате эмодзи шифруется, как сообщение: сервер не видит, что поставили.
        await messagesApi.react(chatId, messageId, await sealForChat(chat, myId, emoji));
      }
      updateMessages(chatId, (msgs) =>
        msgs.map((m) =>
          m.id === messageId
            ? {
                ...m,
                reactions: applyReaction(
                  m.reactions,
                  myId,
                  emoji === null ? null : { user_id: myId, payload: emoji }
                ),
              }
            : m
        )
      );
    },

    setChatBackground: async (chatId, file) => {
      const chat = get().chats.find((c) => c.id === chatId);
      const myId = useAuthStore.getState().user?.id;
      if (!chat || !myId) return;
      if (!file) {
        await chatsApi.removeBackground(chatId);
        applyBackground(chatId, null, null);
        return;
      }
      const ref = await uploadChatImage(chatId, file);
      const payload = await sealForChat(chat, myId, encodeImage(ref));
      await chatsApi.setBackground(chatId, payload, ref.id);
      applyBackground(chatId, payload, ref);
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
