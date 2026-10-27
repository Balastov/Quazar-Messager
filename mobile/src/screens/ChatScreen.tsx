import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {launchImageLibrary} from 'react-native-image-picker';
import {isUnreadable, useChatStore} from '../store/chat';
import {useAuthStore} from '../store/auth';
import {useCallStore} from '../store/call';
import type {RootStackParamList} from '../navigation';
import type {Message} from '../api/types';
import {splitLinks} from '../utils/linkify';
import type {StickerInfo} from '../api/stickers';
import {useStickersStore} from '../store/stickers';
import {encodeSticker, parseSticker} from '../stickers/format';
import Sticker from '../components/Sticker';
import StickerPanel from '../components/StickerPanel';
import {usePresenceText} from '../store/presence';
import ChatImage from '../components/ChatImage';
import {MAX_IMAGE_BYTES, parseImage} from '../attachments/image';
import {loadImageUri} from '../attachments/cache';
import {parseVoice, voicePreview} from '../attachments/voice';
import {filePreview, formatSize, parseFile} from '../attachments/file';
import MessageActions, {type MessageAction} from '../components/MessageActions';
import {groupReactions, myReaction, toggledReaction} from '../chat/reactions';
import {displayName} from '../utils/profile';

const STICKER_SIZE = 150;
const NO_TYPING: string[] = [];

/** Короткая строка о сообщении — для цитаты и полосы «Ответ …». */
function previewOf(payload: string, stickerEmoji: (pack: string, id: string) => string | undefined) {
  if (parseImage(payload)) {
    return '📷 Фото';
  }
  const voice = parseVoice(payload);
  if (voice) {
    return voicePreview(voice);
  }
  const file = parseFile(payload);
  if (file) {
    return filePreview(file);
  }
  const ref = parseSticker(payload);
  if (ref) {
    const emoji = stickerEmoji(ref.pack, ref.id);
    return emoji ? `Стикер ${emoji}` : 'Стикер';
  }
  return payload;
}

/** «Аня печатает…», «Аня и Боря печатают…», «Аня и ещё 2 печатают…». */
function typingLabel(names: string[]): string | null {
  if (names.length === 0) {
    return null;
  }
  if (names.length === 1) {
    return `${names[0]} печатает…`;
  }
  if (names.length === 2) {
    return `${names[0]} и ${names[1]} печатают…`;
  }
  return `${names[0]} и ещё ${names.length - 1} печатают…`;
}

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

/** Текст сообщения, где ссылки нажимаются и открываются в браузере. */
function MessageText({text, isOwn}: {text: string; isOwn: boolean}) {
  const parts = React.useMemo(() => splitLinks(text), [text]);
  return (
    <Text style={s.text}>
      {parts.map((part, i) =>
        part.type === 'link' ? (
          <Text
            key={i}
            style={[s.link, isOwn ? s.linkOwn : s.linkOther]}
            onPress={() => void Linking.openURL(part.href).catch(() => {})}
            accessibilityRole="link">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

export default function ChatScreen({route, navigation}: Props) {
  const {chatId} = route.params;
  const {
    messages,
    loadingMessages,
    selectChat,
    leaveChat,
    sendMessage,
    sendImage,
    editMessage,
    deleteMessage,
    hideMessage,
    react,
    notifyTyping,
    chats,
  } = useChatStore();
  const typingIds = useChatStore(st => st.typing[chatId] ?? NO_TYPING);
  const currentUser = useAuthStore(s => s.user);
  const startAudioCall = useCallStore(s => s.startAudioCall);
  const startVideoCall = useCallStore(s => s.startVideoCall);
  const callPhase = useCallStore(s => s.phase);
  const callBusy = callPhase !== 'idle' && callPhase !== 'ended';
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const background = useChatStore(st => st.backgrounds[chatId]);
  const [backgroundUri, setBackgroundUri] = useState<string | null>(null);
  const stickersByKey = useStickersStore(st => st.byKey);
  const stickersLoaded = useStickersStore(st => st.loaded);
  const loadStickers = useStickersStore(st => st.load);
  const listRef = useRef<FlatList<Message>>(null);
  const nearBottom = useRef(true);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const msgs = messages[chatId] ?? [];
  const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
  const chat = chats.find(c => c.id === chatId);
  const isDirect = chat?.type === 'direct';
  const myRole = chat?.members.find(m => m.user.id === currentUser?.id)?.role;
  const nameOf = (userId: string | null | undefined) => {
    if (userId && userId === currentUser?.id) {
      return 'Вы';
    }
    return displayName(chat?.members.find(m => m.user.id === userId)?.user) ?? 'Участник';
  };
  const stickerEmoji = (pack: string, id: string) => stickersByKey[`${pack}/${id}`]?.emoji;
  const typingText = typingIds.length
    ? isDirect
      ? 'печатает…'
      : typingLabel(typingIds.map(nameOf))
    : null;
  const peerId =
    chat?.type === 'direct'
      ? chat.members.find(m => m.user.id !== currentUser?.id)?.user.id ?? null
      : null;
  const canCall = chat?.type === 'direct' && !!peerId && !callBusy;
  const peerStatus = usePresenceText(peerId);

  // В шапке под именем — «в сети» / «был(а) …».
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View>
          <Text style={s.headerTitle} numberOfLines={1}>
            {route.params.title}
          </Text>
          {typingText ? (
            <Text style={[s.headerSub, s.headerTyping]} numberOfLines={1}>
              {typingText}
            </Text>
          ) : (
            peerStatus && (
              <Text
                style={[
                  s.headerSub,
                  peerStatus === 'в сети' && s.headerOnline,
                  peerStatus?.startsWith('отошёл') && s.headerAway,
                  (peerStatus?.startsWith('на встрече') || peerStatus?.startsWith('не беспокоить')) && s.headerBusy,
                ]}>
                {peerStatus}
              </Text>
            )
          )}
        </View>
      ),
    });
  }, [navigation, route.params.title, peerStatus, typingText]);

  // Сообщение, на которое отвечаем или которое правим, удалили — убираем и полосу над вводом.
  useEffect(() => {
    if (replyTo && !msgs.some(m => m.id === replyTo.id)) {
      setReplyTo(null);
    }
    if (editing && !msgs.some(m => m.id === editing.id)) {
      setEditing(null);
      setText('');
    }
  }, [msgs, replyTo, editing]);

  // Чат «открыт», только пока его экран на виду: ушли назад или на другой экран —
  // новые сообщения приходят как доставленные, а не прочитанные.
  useFocusEffect(
    useCallback(() => {
      selectChat(chatId);
      return () => leaveChat(chatId);
    }, [chatId, selectChat, leaveChat]),
  );

  // Общий фон чата (ставят с любого устройства собеседников) — зашифрован, как фото.
  useEffect(() => {
    setBackgroundUri(null);
    if (!background) {
      return;
    }
    let alive = true;
    loadImageUri(chatId, background)
      .then(uri => alive && setBackgroundUri(uri))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId, background]);

  useEffect(() => {
    void loadStickers();
  }, [loadStickers]);

  const toggleStickers = () => {
    if (!stickersOpen) {
      Keyboard.dismiss();
    }
    setStickersOpen(open => !open);
  };

  const handleSticker = async (packId: string, sticker: StickerInfo) => {
    setSendError(null);
    const reply = replyTo;
    setReplyTo(null);
    try {
      await sendMessage(chatId, encodeSticker(packId, sticker.id), undefined, reply?.id);
    } catch (err) {
      setReplyTo(reply);
      setSendError(err instanceof Error ? err.message : 'Не удалось отправить стикер');
    }
  };

  const pickImages = async () => {
    setStickersOpen(false);
    setSendError(null);
    const res = await launchImageLibrary({
      mediaType: 'photo',
      selectionLimit: 10,
      includeBase64: true,
      // Как Telegram: длинная сторона до 2560 px, JPEG ~0.8 — в 5–10 раз меньше исходника,
      // и без EXIF с геопозицией. (На Android GIF при этом становится статичной картинкой.)
      maxWidth: 2560,
      maxHeight: 2560,
      quality: 0.8,
      // HEIC с iPhone → JPEG: иначе собеседник в браузере его не откроет.
      assetRepresentationMode: 'compatible',
    });
    if (res.didCancel) {
      return;
    }
    if (res.errorCode) {
      setSendError(res.errorMessage || 'Не удалось открыть галерею');
      return;
    }
    // Ответом становится первая картинка из выбранных.
    let reply = replyTo?.id;
    setReplyTo(null);
    // По одной, в порядке выбора: так они и лягут в чат.
    for (const asset of res.assets ?? []) {
      if ((asset.fileSize ?? 0) > MAX_IMAGE_BYTES) {
        setSendError('Картинка больше 10 МБ — такую не отправить');
        continue;
      }
      if (!asset.base64) {
        setSendError('Не удалось прочитать картинку');
        continue;
      }
      setUploading(n => n + 1);
      try {
        await sendImage(
          chatId,
          {
            base64: asset.base64,
            width: asset.width || 800,
            height: asset.height || 600,
          },
          reply,
        );
        reply = undefined;
      } catch (err) {
        setSendError(err instanceof Error ? err.message : 'Не удалось отправить картинку');
      } finally {
        setUploading(n => n - 1);
      }
    }
  };

  useEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        canCall ? (
          <View style={{flexDirection: 'row', gap: 14, marginRight: 4}}>
            <Pressable
              onPress={() => {
                if (peerId) {
                  void startAudioCall(chatId, peerId);
                }
              }}
              hitSlop={8}>
              <Text style={{color: '#c4b5fd', fontSize: 16, fontWeight: '600'}}>
                📞
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (peerId) {
                  void startVideoCall(chatId, peerId);
                }
              }}
              hitSlop={8}>
              <Text style={{color: '#c4b5fd', fontSize: 16, fontWeight: '600'}}>
                🎥
              </Text>
            </Pressable>
          </View>
        ) : null,
    });
  }, [
    navigation,
    canCall,
    peerId,
    chatId,
    startAudioCall,
    startVideoCall,
  ]);

  // Вниз — когда пришло новое сообщение (а не при удалении или реакции),
  // если человек и так внизу или написал сам.
  const lastId = lastMsg?.id;
  const lastIsMine = lastMsg?.sender_id === currentUser?.id;
  useEffect(() => {
    if (lastId && (nearBottom.current || lastIsMine)) {
      listRef.current?.scrollToEnd({animated: true});
    }
  }, [lastId, lastIsMine]);

  const startReply = (msg: Message) => {
    setEditing(null);
    setReplyTo(msg);
    inputRef.current?.focus();
  };

  const startEdit = (msg: Message) => {
    setReplyTo(null);
    setEditing(msg);
    setText(msg.payload);
    setStickersOpen(false);
    inputRef.current?.focus();
  };

  const cancelContext = () => {
    if (editing) {
      setText('');
    }
    setEditing(null);
    setReplyTo(null);
  };

  const handleSend = async () => {
    const payload = text.trim();
    if (!payload) {
      return;
    }
    setSendError(null);

    if (editing) {
      const target = editing;
      setEditing(null);
      setText('');
      if (payload === target.payload) {
        return;
      }
      try {
        await editMessage(chatId, target.id, payload);
      } catch (err) {
        setEditing(target);
        setText(payload);
        setSendError(err instanceof Error ? err.message : 'Не удалось исправить сообщение');
      }
      return;
    }

    const reply = replyTo;
    setText('');
    setReplyTo(null);
    try {
      await sendMessage(chatId, payload, undefined, reply?.id);
    } catch (err) {
      setText(payload);
      setReplyTo(reply);
      setSendError(err instanceof Error ? err.message : 'Не удалось отправить сообщение');
    }
  };

  const handleTextChange = (value: string) => {
    setText(value);
    if (!editing && value.trim()) {
      notifyTyping(chatId);
    }
  };

  const handleReact = async (msg: Message, emoji: string) => {
    setSendError(null);
    try {
      await react(chatId, msg.id, toggledReaction(myReaction(msg.reactions, currentUser?.id), emoji));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Не удалось поставить реакцию');
    }
  };

  const confirmDelete = (msg: Message) => {
    const own = msg.sender_id === currentUser?.id;
    const forAll = own || (chat?.type === 'group' && (myRole === 'owner' || myRole === 'admin'));
    const run = async (fn: () => Promise<void>) => {
      setSendError(null);
      try {
        await fn();
      } catch {
        setSendError('Не удалось удалить сообщение');
      }
    };
    Alert.alert(
      'Удалить сообщение?',
      forAll ? undefined : 'Оно пропадёт только у вас — у остальных останется.',
      [
        ...(forAll
          ? [
              {
                text: isDirect ? `У меня и у ${route.params.title}` : 'У всех',
                style: 'destructive' as const,
                onPress: () => void run(() => deleteMessage(chatId, msg.id)),
              },
            ]
          : []),
        {
          text: forAll ? 'Только у меня' : 'Удалить',
          style: 'destructive' as const,
          onPress: () => void run(() => hideMessage(chatId, msg.id)),
        },
        {text: 'Отмена', style: 'cancel' as const},
      ],
    );
  };

  const actionsFor = (msg: Message): MessageAction[] => {
    const own = msg.sender_id === currentUser?.id;
    const plain =
      !parseImage(msg.payload) &&
      !parseVoice(msg.payload) &&
      !parseFile(msg.payload) &&
      !parseSticker(msg.payload) &&
      !isUnreadable(msg.payload);
    const actions: MessageAction[] = [{label: 'Ответить', onPress: () => startReply(msg)}];
    if (own && plain && !msg.forwarded_from) {
      actions.push({label: 'Изменить', onPress: () => startEdit(msg)});
    }
    actions.push({label: 'Удалить', danger: true, onPress: () => confirmDelete(msg)});
    return actions;
  };

  /** Из цитаты — к исходному сообщению, с подсветкой. */
  const revealMessage = (messageId: string) => {
    const index = msgs.findIndex(m => m.id === messageId);
    if (index < 0) {
      return;
    }
    nearBottom.current = false;
    listRef.current?.scrollToIndex({index, viewPosition: 0.5, animated: true});
    setHighlightId(messageId);
    setTimeout(() => setHighlightId(id => (id === messageId ? null : id)), 1600);
  };

  const statusIcon = (status: string) => {
    if (status === 'read' || status === 'delivered') {
      return '✓✓';
    }
    return '✓';
  };

  // Одна серая — отправлено, две серые — доставлено, две фирменные зелёные — прочитано.
  const statusColor = (status: string) =>
    status === 'read' ? '#34d399' : 'rgba(255,255,255,0.55)';

  const renderItem = ({item}: {item: Message}) => {
    const isOwn = item.sender_id === currentUser?.id;
    const image = parseImage(item.payload);
    const voice = image ? null : parseVoice(item.payload);
    const file = image || voice ? null : parseFile(item.payload);
    const ref = image || voice || file ? null : parseSticker(item.payload);
    const sticker = ref ? stickersByKey[`${ref.pack}/${ref.id}`] : undefined;
    // Стикер без пузыря; неизвестный (пак убрали с сервера) — строкой в пузыре.
    const asSticker = !!ref && (!!sticker || !stickersLoaded);
    const groups = groupReactions(item.reactions, currentUser?.id);
    const openActions = () => setActionMsg(item);

    const containerStyle = image
      ? [s.bubble, s.imageBubble, isOwn ? s.own : s.other]
      : asSticker
        ? [s.stickerMsg, isOwn ? s.stickerOwn : s.stickerOther]
        : [s.bubble, isOwn ? s.own : s.other];

    return (
      <Pressable
        onLongPress={openActions}
        delayLongPress={350}
        style={[containerStyle, highlightId === item.id && s.highlight]}>
        {chat?.type === 'group' && !isOwn && <Text style={s.author}>{nameOf(item.sender_id)}</Text>}
        {item.forwarded_from && (
          <Text style={s.forwarded}>Переслано от {item.forwarded_from}</Text>
        )}
        {item.reply_to && (
          <Pressable
            style={[s.quote, isOwn && !asSticker && s.quoteOwn]}
            onPress={() => revealMessage(item.reply_to!.id)}
            onLongPress={openActions}>
            <Text style={[s.quoteAuthor, isOwn && !asSticker && s.quoteAuthorOwn]} numberOfLines={1}>
              {nameOf(item.reply_to.sender_id)}
            </Text>
            <Text style={s.quoteText} numberOfLines={1}>
              {previewOf(item.reply_to.payload, stickerEmoji)}
            </Text>
          </Pressable>
        )}
        {image ? (
          <ChatImage chatId={item.chat_id} image={image} onLongPress={openActions} />
        ) : voice ? (
          <Text style={s.textMuted}>{voicePreview(voice)} — послушайте в веб-версии</Text>
        ) : file ? (
          <Text style={s.textMuted}>
            {filePreview(file)} · {formatSize(file.size)} — скачайте в веб-версии
          </Text>
        ) : asSticker ? (
          sticker ? (
            <Sticker sticker={sticker} size={STICKER_SIZE} animate />
          ) : (
            <View style={{width: STICKER_SIZE, height: STICKER_SIZE}} />
          )
        ) : ref ? (
          <Text style={s.textMuted}>Стикер недоступен</Text>
        ) : (
          <MessageText text={item.payload} isOwn={isOwn} />
        )}
        {groups.length > 0 && (
          <View style={s.reactions}>
            {groups.map(g => (
              <Pressable
                key={g.emoji}
                style={[s.chip, g.mine && s.chipMine]}
                onPress={() => void handleReact(item, g.emoji)}
                accessibilityLabel={g.mine ? `Убрать ${g.emoji}` : `Реакция ${g.emoji}`}>
                <Text style={s.chipText}>
                  {g.emoji}
                  {g.count > 1 ? ` ${g.count}` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={[s.meta, image && s.imageMeta]}>
          {item.expires_at && <Text style={s.time}>⏱</Text>}
          {item.edited_at && <Text style={s.time}>изм.</Text>}
          <Text style={s.time}>
            {new Date(item.created_at).toLocaleTimeString('ru', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          {isOwn && (
            <Text style={[s.status, {color: statusColor(item.status)}]}>
              {statusIcon(item.status)}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      {backgroundUri && (
        <>
          <Image source={{uri: backgroundUri}} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, s.backgroundShade]} />
        </>
      )}
      {loadingMessages ? (
        <ActivityIndicator style={{flex: 1}} color="#6c63ff" />
      ) : (
        <FlatList
          ref={listRef}
          data={msgs}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          onScroll={e => {
            const {contentOffset, contentSize, layoutMeasurement} = e.nativeEvent;
            nearBottom.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            // Внизу — держимся низа (картинка догрузилась, пришла реакция); выше — не дёргаем.
            if (nearBottom.current) {
              listRef.current?.scrollToEnd({animated: false});
            }
          }}
          onScrollToIndexFailed={info => {
            // Строка ещё не измерена — прокрутим примерно и попробуем снова.
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            });
            setTimeout(
              () =>
                listRef.current?.scrollToIndex({
                  index: info.index,
                  viewPosition: 0.5,
                  animated: true,
                }),
              100,
            );
          }}
        />
      )}

      {uploading > 0 && (
        <Text style={s.uploading}>
          {uploading > 1 ? `Отправка картинок: ${uploading}…` : 'Отправка картинки…'}
        </Text>
      )}
      {sendError && <Text style={s.sendError}>{sendError}</Text>}
      {(replyTo || editing) && (
        <View style={s.context}>
          <Text style={s.contextIcon}>{editing ? '✎' : '↩'}</Text>
          <View style={s.contextBody}>
            <Text style={s.contextTitle} numberOfLines={1}>
              {editing
                ? 'Редактирование'
                : replyTo!.sender_id === currentUser?.id
                  ? 'Ответ себе'
                  : `Ответ ${nameOf(replyTo!.sender_id)}`}
            </Text>
            <Text style={s.contextText} numberOfLines={1}>
              {editing ? editing.payload : previewOf(replyTo!.payload, stickerEmoji)}
            </Text>
          </View>
          <Pressable
            onPress={cancelContext}
            hitSlop={10}
            accessibilityLabel={editing ? 'Отменить правку' : 'Не отвечать'}>
            <Text style={s.contextClose}>✕</Text>
          </Pressable>
        </View>
      )}
      <View style={s.inputRow}>
        {!editing && (
          <>
            <Pressable
              style={s.stickerBtn}
              onPress={() => void pickImages()}
              accessibilityLabel="Отправить картинку"
              hitSlop={6}>
              <Text style={s.stickerIcon}>🖼️</Text>
            </Pressable>
            <Pressable
              style={[s.stickerBtn, stickersOpen && s.stickerBtnActive]}
              onPress={toggleStickers}
              accessibilityLabel={stickersOpen ? 'Клавиатура' : 'Стикеры'}
              hitSlop={6}>
              <Text style={s.stickerIcon}>{stickersOpen ? '⌨️' : '🙂'}</Text>
            </Pressable>
          </>
        )}
        <TextInput
          ref={inputRef}
          style={s.input}
          placeholder="Написать сообщение..."
          placeholderTextColor="#555"
          value={text}
          onChangeText={handleTextChange}
          onFocus={() => setStickersOpen(false)}
          multiline
        />
        <Pressable
          style={[s.sendBtn, !text.trim() && s.disabled]}
          onPress={handleSend}
          disabled={!text.trim()}
          accessibilityLabel={editing ? 'Сохранить' : 'Отправить'}>
          <Text style={s.sendIcon}>{editing ? '✓' : '➤'}</Text>
        </Pressable>
      </View>
      {stickersOpen && (
        <StickerPanel onPick={(packId, st) => void handleSticker(packId, st)} />
      )}
      {actionMsg && (
        <MessageActions
          reaction={{
            current: myReaction(actionMsg.reactions, currentUser?.id),
            onPick: emoji => void handleReact(actionMsg, emoji),
          }}
          actions={actionsFor(actionMsg)}
          onClose={() => setActionMsg(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
  // Затемнение поверх фона чата, чтобы пузыри читались.
  backgroundShade: {backgroundColor: 'rgba(15,17,23,0.35)'},
  list: {paddingHorizontal: 12, paddingVertical: 8, gap: 6},
  bubble: {
    maxWidth: '72%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  own: {
    alignSelf: 'flex-end',
    backgroundColor: '#6c63ff',
    borderBottomRightRadius: 4,
  },
  other: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a1d27',
    borderBottomLeftRadius: 4,
  },
  text: {color: '#fff', fontSize: 14, lineHeight: 20},
  headerTitle: {color: '#e0e0e0', fontSize: 16, fontWeight: '600'},
  headerSub: {color: '#9b93b8', fontSize: 12},
  headerOnline: {color: '#34d399'},
  headerAway: {color: '#fbbf24'},
  headerBusy: {color: '#f87171'},
  headerTyping: {color: '#c4b5fd'},
  author: {color: '#d8b4fe', fontSize: 12, fontWeight: '600', marginBottom: 2},
  forwarded: {color: 'rgba(255,255,255,0.75)', fontSize: 12, fontStyle: 'italic', marginBottom: 2},
  highlight: {borderWidth: 2, borderColor: '#c084fc'},
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: '#c084fc',
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 4,
  },
  quoteOwn: {borderLeftColor: 'rgba(255,255,255,0.85)', backgroundColor: 'rgba(255,255,255,0.14)'},
  quoteAuthor: {color: '#d8b4fe', fontSize: 12, fontWeight: '600'},
  quoteAuthorOwn: {color: '#fff'},
  quoteText: {color: 'rgba(255,255,255,0.75)', fontSize: 12},
  reactions: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4},
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2a2d3a',
    backgroundColor: 'rgba(15,17,23,0.35)',
  },
  chipMine: {borderColor: 'rgba(216,180,254,0.8)', backgroundColor: 'rgba(168,85,247,0.4)'},
  chipText: {color: '#fff', fontSize: 13},
  context: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#1a1d27',
    borderTopWidth: 1,
    borderTopColor: '#2a2d3a',
  },
  contextIcon: {color: '#c084fc', fontSize: 16, width: 18, textAlign: 'center'},
  contextBody: {flex: 1, borderLeftWidth: 2, borderLeftColor: '#c084fc', paddingLeft: 8},
  contextTitle: {color: '#d8b4fe', fontSize: 12, fontWeight: '600'},
  contextText: {color: '#9b93b8', fontSize: 13},
  contextClose: {color: '#9b93b8', fontSize: 16, paddingHorizontal: 4},
  textMuted: {color: 'rgba(255,255,255,0.65)', fontSize: 13, fontStyle: 'italic'},
  stickerMsg: {gap: 2},
  imageBubble: {paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6},
  imageMeta: {paddingRight: 6},
  uploading: {
    color: '#9b93b8',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 6,
  },
  stickerOwn: {alignSelf: 'flex-end', alignItems: 'flex-end'},
  stickerOther: {alignSelf: 'flex-start', alignItems: 'flex-start'},
  stickerBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickerBtnActive: {backgroundColor: 'rgba(108,99,255,0.25)'},
  stickerIcon: {fontSize: 22},
  link: {textDecorationLine: 'underline'},
  linkOwn: {color: '#fff'},
  linkOther: {color: '#d8c8ff'},
  meta: {flexDirection: 'row', gap: 4, alignSelf: 'flex-end', marginTop: 2},
  time: {color: 'rgba(255,255,255,0.6)', fontSize: 11},
  status: {fontSize: 11, letterSpacing: -1},
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    gap: 8,
    backgroundColor: '#1a1d27',
    borderTopWidth: 1,
    borderTopColor: '#2a2d3a',
  },
  input: {
    flex: 1,
    backgroundColor: '#0f1117',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    color: '#e0e0e0',
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {opacity: 0.4},
  sendError: {
    color: '#fbbf24',
    fontSize: 13,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#1a1d27',
  },
  sendIcon: {color: '#fff', fontSize: 18},
});
