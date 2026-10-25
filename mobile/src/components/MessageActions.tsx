import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {REACTIONS} from '../chat/reactions';

export interface MessageAction {
  label: string;
  onPress: () => void;
  danger?: boolean;
}

interface Props {
  /** null — реакции здесь ставить нельзя (например, нет ключей шифрования). */
  reaction: {current: string | null; onPick: (emoji: string) => void} | null;
  actions: MessageAction[];
  onClose: () => void;
}

/** Шторка по долгому нажатию на сообщение: строка реакций и действия. */
export default function MessageActions({reaction, actions, onClose}: Props) {
  const insets = useSafeAreaInsets();
  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Закрыть">
        <Pressable style={[s.sheet, {paddingBottom: 12 + insets.bottom}]} onPress={() => {}}>
          {reaction && (
            <View style={s.reactions}>
              {REACTIONS.map(emoji => (
                <Pressable
                  key={emoji}
                  style={[s.emoji, emoji === reaction.current && s.emojiActive]}
                  onPress={() => run(() => reaction.onPick(emoji))}
                  accessibilityLabel={
                    emoji === reaction.current ? `Убрать ${emoji}` : `Реакция ${emoji}`
                  }
                  hitSlop={4}>
                  <Text style={s.emojiText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {actions.map(a => (
            <Pressable
              key={a.label}
              style={({pressed}) => [s.item, pressed && s.itemPressed]}
              onPress={() => run(a.onPress)}>
              <Text style={[s.itemText, a.danger && s.danger]}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable style={({pressed}) => [s.item, pressed && s.itemPressed]} onPress={onClose}>
            <Text style={[s.itemText, s.cancel]}>Отмена</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)'},
  sheet: {
    backgroundColor: '#1a1d27',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 10,
    paddingHorizontal: 10,
    borderTopWidth: 1,
    borderColor: '#2a2d3a',
  },
  reactions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingBottom: 10,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2d3a',
  },
  emoji: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  emojiActive: {backgroundColor: 'rgba(168,85,247,0.35)'},
  emojiText: {fontSize: 24},
  item: {paddingVertical: 13, paddingHorizontal: 12, borderRadius: 10},
  itemPressed: {backgroundColor: 'rgba(255,255,255,0.06)'},
  itemText: {color: '#e0e0e0', fontSize: 16},
  danger: {color: '#f87171'},
  cancel: {color: '#9b93b8'},
});
