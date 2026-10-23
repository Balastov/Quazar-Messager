import React, {useEffect, useState} from 'react';
import {isAxiosError} from 'axios';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {fitSize, type ImageRef} from '../attachments/image';
import {loadImageUri} from '../attachments/cache';

const MAX_H = 320;

interface Props {
  chatId: string;
  image: ImageRef;
}

/** Картинка из сообщения: скачивает шифротекст, расшифровывает, по нажатию — на весь экран. */
export default function ChatImage({chatId, image}: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState<'expired' | 'error' | null>(null);
  const [open, setOpen] = useState(false);
  const {width: screenW} = useWindowDimensions();
  const box = fitSize(image.w, image.h, Math.round(screenW * 0.68), MAX_H);

  useEffect(() => {
    let alive = true;
    setFailed(null);
    loadImageUri(chatId, image)
      .then(u => alive && setUri(u))
      .catch(err => {
        // 404 — сервер удалил картинку по сроку хранения (30 дней).
        if (alive) {
          setFailed(isAxiosError(err) && err.response?.status === 404 ? 'expired' : 'error');
        }
      });
    return () => {
      alive = false;
    };
  }, [chatId, image.id, image.key]);

  if (failed) {
    return (
      <View style={[s.box, s.failed, {width: box.width}]}>
        <Text style={s.failedText}>
          {failed === 'expired' ? 'Фото удалено — они хранятся 30 дней' : 'Картинка недоступна'}
        </Text>
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => uri && setOpen(true)}
        style={[s.box, {width: box.width, height: box.height}]}
        accessibilityRole="imagebutton"
        accessibilityLabel="Открыть картинку">
        {uri ? (
          <Image source={{uri}} style={s.fill} resizeMode="cover" />
        ) : (
          <ActivityIndicator color="#fff" />
        )}
      </Pressable>
      {uri && (
        <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <Pressable style={s.viewer} onPress={() => setOpen(false)}>
            <Image source={{uri}} style={s.fill} resizeMode="contain" />
          </Pressable>
        </Modal>
      )}
    </>
  );
}

const s = StyleSheet.create({
  box: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: {width: '100%', height: '100%'},
  failed: {minHeight: 48, paddingHorizontal: 12},
  failedText: {color: 'rgba(255,255,255,0.65)', fontSize: 13, fontStyle: 'italic'},
  viewer: {flex: 1, backgroundColor: 'rgba(5,4,12,0.94)', padding: 12},
});
