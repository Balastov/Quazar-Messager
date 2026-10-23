import React, {useEffect, useRef, useState} from 'react';
import {
  FlatList,
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
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {launchImageLibrary} from 'react-native-image-picker';
import {useChatStore} from '../store/chat';
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

const STICKER_SIZE = 150;

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
  const {messages, loadingMessages, selectChat, sendMessage, sendImage, chats} =
    useChatStore();
  const currentUser = useAuthStore(s => s.user);
  const startAudioCall = useCallStore(s => s.startAudioCall);
  const startVideoCall = useCallStore(s => s.startVideoCall);
  const callPhase = useCallStore(s => s.phase);
  const callBusy = callPhase !== 'idle' && callPhase !== 'ended';
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const stickersByKey = useStickersStore(st => st.byKey);
  const stickersLoaded = useStickersStore(st => st.loaded);
  const loadStickers = useStickersStore(st => st.load);
  const listRef = useRef<FlatList<Message>>(null);

  const msgs = messages[chatId] ?? [];
  const chat = chats.find(c => c.id === chatId);
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
          {peerStatus && (
            <Text
              style={[
                s.headerSub,
                peerStatus === 'в сети' && s.headerOnline,
                peerStatus?.startsWith('отошёл') && s.headerAway,
                (peerStatus?.startsWith('на встрече') || peerStatus?.startsWith('не беспокоить')) && s.headerBusy,
              ]}>
              {peerStatus}
            </Text>
          )}
        </View>
      ),
    });
  }, [navigation, route.params.title, peerStatus]);

  useEffect(() => {
    selectChat(chatId);
  }, [chatId, selectChat]);

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
    try {
      await sendMessage(chatId, encodeSticker(packId, sticker.id));
    } catch (err) {
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
        await sendImage(chatId, {
          base64: asset.base64,
          width: asset.width || 800,
          height: asset.height || 600,
        });
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

  useEffect(() => {
    if (msgs.length > 0) {
      listRef.current?.scrollToEnd({animated: true});
    }
  }, [msgs.length]);

  const handleSend = async () => {
    const payload = text.trim();
    if (!payload) {
      return;
    }
    setText('');
    setSendError(null);
    try {
      await sendMessage(chatId, payload);
    } catch (err) {
      setText(payload);
      setSendError(err instanceof Error ? err.message : 'Не удалось отправить сообщение');
    }
  };

  const statusIcon = (status: string) => {
    if (status === 'read' || status === 'delivered') {
      return '✓✓';
    }
    return '✓';
  };

  const statusColor = (status: string) => {
    if (status === 'read') {
      return '#67e8f9';
    }
    if (status === 'delivered') {
      return '#93c5fd';
    }
    return 'rgba(255,255,255,0.55)';
  };

  const renderItem = ({item}: {item: Message}) => {
    const isOwn = item.sender_id === currentUser?.id;
    const image = parseImage(item.payload);
    if (image) {
      return (
        <View style={[s.bubble, s.imageBubble, isOwn ? s.own : s.other]}>
          <ChatImage chatId={item.chat_id} image={image} />
          <View style={[s.meta, s.imageMeta]}>
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
        </View>
      );
    }
    const ref = parseSticker(item.payload);
    const sticker = ref ? stickersByKey[`${ref.pack}/${ref.id}`] : undefined;
    // Стикер без пузыря; неизвестный (пак убрали с сервера) — строкой в пузыре.
    const asSticker = !!ref && (!!sticker || !stickersLoaded);
    return (
      <View style={asSticker ? [s.stickerMsg, isOwn ? s.stickerOwn : s.stickerOther] : [s.bubble, isOwn ? s.own : s.other]}>
        {asSticker ? (
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
        <View style={s.meta}>
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
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      {loadingMessages ? (
        <ActivityIndicator style={{flex: 1}} color="#6c63ff" />
      ) : (
        <FlatList
          ref={listRef}
          data={msgs}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({animated: false})
          }
        />
      )}

      {uploading > 0 && (
        <Text style={s.uploading}>
          {uploading > 1 ? `Отправка картинок: ${uploading}…` : 'Отправка картинки…'}
        </Text>
      )}
      {sendError && <Text style={s.sendError}>{sendError}</Text>}
      <View style={s.inputRow}>
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
        <TextInput
          style={s.input}
          placeholder="Написать сообщение..."
          placeholderTextColor="#555"
          value={text}
          onChangeText={setText}
          onFocus={() => setStickersOpen(false)}
          multiline
        />
        <Pressable
          style={[s.sendBtn, !text.trim() && s.disabled]}
          onPress={handleSend}
          disabled={!text.trim()}>
          <Text style={s.sendIcon}>➤</Text>
        </Pressable>
      </View>
      {stickersOpen && (
        <StickerPanel onPick={(packId, st) => void handleSticker(packId, st)} />
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
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
