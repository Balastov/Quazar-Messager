import React, {useState} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {usersApi} from '../api/users';
import {useAuthStore} from '../store/auth';
import {apiErrorText} from '../utils/profile';
import PhoneVisibilityChoice, {PHONE_VISIBILITY_QUESTION} from './PhoneVisibilityChoice';

/** Аккаунты до появления настройки: при входе спрашиваем один раз. Закрыть без выбора нельзя. */
export default function PhoneVisibilityGate() {
  const user = useAuthStore(st => st.user);
  const setUser = useAuthStore(st => st.setUser);
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Строго null — ответ сервера «ещё не выбирал»; undefined — профиль ещё не перечитан.
  if (!user || user.phone_discoverable !== null) {
    return null;
  }

  const save = async () => {
    if (value === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setUser(await usersApi.updateMe({phone_discoverable: value}));
    } catch (err) {
      setError(apiErrorText(err, 'Не удалось сохранить — попробуйте ещё раз'));
    } finally {
      setBusy(false);
    }
  };

  return (
    // onRequestClose пустой: «Назад» на Android окно не закрывает — выбор обязателен.
    <Modal transparent animationType="fade" visible onRequestClose={() => {}}>
      <View style={s.overlay}>
        <View style={s.panel}>
          <Text style={s.title}>{PHONE_VISIBILITY_QUESTION}</Text>
          <Text style={s.lead}>
            Мы добавили настройку приватности номера. Выберите вариант — изменить его можно в любой
            момент в профиле.
          </Text>
          <PhoneVisibilityChoice value={value} onChange={setValue} disabled={busy} showQuestion={false} />
          {error && <Text style={s.error}>{error}</Text>}
          <Pressable
            style={[s.save, (value === null || busy) && s.saveDisabled]}
            onPress={() => void save()}
            disabled={value === null || busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.saveText}>Сохранить</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(4,2,12,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  panel: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#1a1d27',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2a2d3a',
    padding: 20,
    gap: 14,
  },
  title: {color: '#fff', fontSize: 19, fontWeight: '700', lineHeight: 25},
  lead: {color: '#9b93b8', fontSize: 13, lineHeight: 18, marginTop: -4},
  error: {color: '#ff6b6b', fontSize: 13},
  save: {
    backgroundColor: '#6c63ff',
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  saveDisabled: {opacity: 0.45},
  saveText: {color: '#fff', fontWeight: '700', fontSize: 15},
});
