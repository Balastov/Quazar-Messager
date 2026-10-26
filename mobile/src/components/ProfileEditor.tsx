import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {usersApi} from '../api/users';
import type {User} from '../api/types';
import {useUsernameCheck} from '../hooks/useUsernameCheck';
import {useAuthStore} from '../store/auth';
import {apiErrorText, USERNAME_MAX} from '../utils/profile';

type Field = 'username' | 'first_name' | 'last_name' | 'email';

function initial(user: User): Record<Field, string> {
  return {
    username: user.username,
    first_name: user.first_name ?? '',
    last_name: user.last_name ?? '',
    email: user.email ?? '',
  };
}

/** Никнейм, имя, фамилия и почта. Сохраняет только изменённые поля. */
export default function ProfileEditor({user}: {user: User}) {
  const setUser = useAuthStore(st => st.setUser);
  const [form, setForm] = useState(() => initial(user));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useUsernameCheck(form.username, user.username);

  useEffect(() => setForm(initial(user)), [user]);

  const saved = initial(user);
  const changed = (Object.keys(form) as Field[]).filter(k => form[k].trim() !== saved[k]);
  const canSave =
    changed.length > 0 && !busy && check.state !== 'bad' && check.state !== 'checking';

  const set = (k: Field) => (text: string) => {
    setStatus(null);
    setForm(f => ({...f, [k]: k === 'username' ? text.replace(/\s/g, '') : text}));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const body = Object.fromEntries(
        changed.map(k => [k, k === 'username' ? form[k].trim().replace(/^@/, '') : form[k].trim()]),
      );
      setUser(await usersApi.updateMe(body));
      setStatus('Профиль сохранён');
    } catch (err) {
      setError(apiErrorText(err, 'Не удалось сохранить профиль'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.root}>
      <Text style={s.label}>Никнейм</Text>
      <TextInput
        style={s.input}
        value={form.username}
        onChangeText={set('username')}
        maxLength={USERNAME_MAX + 1}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="ascii-capable"
      />
      <Text style={[s.hint, check.state === 'bad' && s.bad, check.state === 'ok' && s.ok]}>
        {check.state === 'bad'
          ? check.message
          : check.state === 'ok'
            ? 'Никнейм свободен'
            : check.state === 'checking'
              ? 'Проверяем…'
              : 'Латиницей. По нему вас находят и @упоминают'}
      </Text>

      <Text style={s.label}>Имя</Text>
      <TextInput
        style={s.input}
        value={form.first_name}
        onChangeText={set('first_name')}
        maxLength={64}
        textContentType="givenName"
      />
      <Text style={s.label}>Фамилия</Text>
      <TextInput
        style={s.input}
        value={form.last_name}
        onChangeText={set('last_name')}
        maxLength={64}
        textContentType="familyName"
      />
      <Text style={s.label}>Электронная почта</Text>
      <TextInput
        style={s.input}
        value={form.email}
        onChangeText={set('email')}
        placeholder="Не указана"
        placeholderTextColor="#555"
        maxLength={254}
        keyboardType="email-address"
        autoCapitalize="none"
        textContentType="emailAddress"
      />
      <Text style={s.hint}>Видна только вам.</Text>

      <View style={s.row}>
        <Pressable
          style={[s.save, !canSave && s.disabled]}
          onPress={() => void save()}
          disabled={!canSave}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.saveText}>Сохранить</Text>}
        </Pressable>
        {changed.length > 0 && !busy && (
          <Pressable
            onPress={() => {
              setForm(initial(user));
              setError(null);
            }}
            hitSlop={6}>
            <Text style={s.cancel}>Отменить</Text>
          </Pressable>
        )}
      </View>
      {status && <Text style={s.ok}>{status}</Text>}
      {error && <Text style={s.bad}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  root: {gap: 6},
  label: {color: '#9b93b8', fontSize: 12, fontWeight: '600', marginTop: 4},
  input: {
    backgroundColor: '#0f1117',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e0e0e0',
    fontSize: 15,
  },
  hint: {color: '#6f678c', fontSize: 12, lineHeight: 16},
  ok: {color: '#4ade80', fontSize: 13},
  bad: {color: '#ff6b6b', fontSize: 13},
  row: {flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 8},
  save: {
    backgroundColor: '#6c63ff',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    minWidth: 120,
    alignItems: 'center',
  },
  disabled: {opacity: 0.45},
  saveText: {color: '#fff', fontWeight: '700', fontSize: 14},
  cancel: {color: '#c4b5fd', fontSize: 14, fontWeight: '600'},
});
