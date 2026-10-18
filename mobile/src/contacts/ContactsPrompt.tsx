import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useContactsStore} from '../store/contacts';

/** Первый вход: предлагаем найти знакомых из телефонной книги. */
export default function ContactsPrompt() {
  const pref = useContactsStore(st => st.pref);
  const enable = useContactsStore(st => st.enable);
  const decline = useContactsStore(st => st.decline);
  const [busy, setBusy] = React.useState(false);

  if (pref !== 'unasked') {
    return null;
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={decline}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <Text style={s.icon}>📇</Text>
          <Text style={s.title}>Найти знакомых в Quazar?</Text>
          <Text style={s.text}>
            Приложение сверит номера из телефонной книги и покажет, кто из ваших контактов уже
            здесь. Номера не сохраняются — на сервере остаются только найденные люди и имя, под
            которым они у вас записаны. Список будет обновляться сам.
          </Text>
          <Pressable
            style={[s.primary, busy && s.disabled]}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void enable().finally(() => setBusy(false));
            }}>
            <Text style={s.primaryText}>{busy ? 'Ищем…' : 'Разрешить доступ к контактам'}</Text>
          </Pressable>
          <Pressable style={s.secondary} onPress={decline} disabled={busy}>
            <Text style={s.secondaryText}>Не сейчас</Text>
          </Pressable>
          <Text style={s.note}>Включить можно позже в профиле.</Text>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#1a1d27',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#2a2d3a',
    padding: 20,
    alignItems: 'center',
    gap: 12,
  },
  icon: {fontSize: 40},
  title: {color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center'},
  text: {color: '#9b93b8', fontSize: 14, lineHeight: 20, textAlign: 'center'},
  primary: {
    alignSelf: 'stretch',
    backgroundColor: '#6c63ff',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryText: {color: '#fff', fontSize: 15, fontWeight: '600'},
  secondary: {alignSelf: 'stretch', paddingVertical: 10, alignItems: 'center'},
  secondaryText: {color: '#c4b5fd', fontSize: 15},
  note: {color: '#6f678c', fontSize: 12},
  disabled: {opacity: 0.5},
});
