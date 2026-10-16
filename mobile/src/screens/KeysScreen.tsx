import React, {useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import axios from 'axios';
import {shortKeyId, StaleBackupError} from '../crypto/keys';
import {useE2EStore} from '../store/e2e';

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (err.response?.status === 401 && detail === 'Invalid password') {
      return 'Неверный пароль аккаунта';
    }
    if (err.response?.status === 401) {return 'Сессия истекла — войдите в аккаунт заново';}
    if (typeof detail === 'string') {return detail;}
  }
  return err instanceof Error ? err.message : 'Ошибка';
}

/** Ключи шифрования: восстановление на этом устройстве, резервная копия, ротация. */
export default function KeysScreen() {
  const status = useE2EStore(s => s.status);
  const hasServerBackup = useE2EStore(s => s.hasServerBackup);
  const hasLocalKey = useE2EStore(s => s.hasLocalKey);
  const busy = useE2EStore(s => s.busy);
  const userId = useE2EStore(s => s.userId);
  const accountPublicKey = useE2EStore(s => s.accountPublicKey);
  const localPublicKey = useE2EStore(s => s.localPublicKey);
  const {restore, createBackup, rotate, adoptBackup, sync} = useE2EStore.getState();

  const [password, setPassword] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [adoptPassword, setAdoptPassword] = useState('');
  /** Копия расшифровалась, но с другим ключом, чем у аккаунта. */
  const [stale, setStale] = useState<{
    backupPassword: string;
    backupPublicKey: string;
    accountPublicKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setPassword('');
      setAccountPassword('');
      setAdoptPassword('');
      setStale(null);
      if (done) {setNotice(done);}
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const runRestore = async () => {
    setError(null);
    setNotice(null);
    setStale(null);
    try {
      await restore(password);
      setPassword('');
    } catch (err) {
      if (err instanceof StaleBackupError) {
        setStale({
          backupPassword: password,
          backupPublicKey: err.backupPublicKey,
          accountPublicKey: err.accountPublicKey,
        });
        return;
      }
      setError(errorMessage(err));
    }
  };

  const needsRestore = status === 'needs_restore';

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      {needsRestore ? (
        <View style={s.card}>
          <Text style={s.title}>Восстановите ключи шифрования</Text>
          <Text style={s.lead}>
            У вашего аккаунта уже есть ключ шифрования с другого устройства. Чтобы читать и
            отправлять личные сообщения здесь, восстановите его из резервной копии.
            {hasLocalKey &&
              ' Прежний ключ этого телефона сохранится — им по-прежнему расшифруется старая переписка.'}
          </Text>
          <Text style={s.hint}>
            Ключ аккаунта: <Text style={s.mono}>{shortKeyId(accountPublicKey)}</Text> · ключ
            этого телефона: <Text style={s.mono}>{shortKeyId(localPublicKey)}</Text>
          </Text>
          {!hasServerBackup && (
            <Text style={s.warn}>
              На сервере нет резервной копии. Откройте Quazar на устройстве, где сообщения
              читаются, и создайте копию: Настройки → Безопасность E2E. Затем нажмите
              «Проверить снова».
            </Text>
          )}
          <TextInput
            style={s.input}
            placeholder="Пароль резервной копии"
            placeholderTextColor="#555"
            secureTextEntry
            autoCapitalize="none"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
          />
          {hasServerBackup ? (
            <Pressable
              style={[s.primary, (busy || password.length < 8) && s.disabled]}
              disabled={busy || password.length < 8}
              onPress={() => void runRestore()}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Восстановить</Text>}
            </Pressable>
          ) : (
            <Pressable
              style={[s.secondary, (busy || !userId) && s.disabled]}
              disabled={busy || !userId}
              onPress={() => userId && void run(() => sync(userId))}>
              <Text style={s.secondaryText}>Проверить снова</Text>
            </Pressable>
          )}
          {busy && (
            <Text style={s.hint}>Расшифровка копии может занять до минуты.</Text>
          )}
        </View>
      ) : (
        <View style={s.card}>
          <Text style={s.title}>Резервная копия ключей</Text>
          <Text style={s.lead}>
            Один ключ шифрования на все ваши устройства. Копия шифруется вашим паролем (сервер
            хранит только ciphertext) и нужна, чтобы открыть переписку на новом устройстве.
          </Text>
          {status === 'ready' && !hasServerBackup && (
            <Text style={s.warn}>Резервной копии пока нет — рекомендуется создать её сейчас.</Text>
          )}
          <TextInput
            style={s.input}
            placeholder="Пароль для копии (≥8)"
            placeholderTextColor="#555"
            secureTextEntry
            autoCapitalize="none"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
          />
          <Pressable
            style={[s.primary, (busy || status !== 'ready' || password.length < 8) && s.disabled]}
            disabled={busy || status !== 'ready' || password.length < 8}
            onPress={() =>
              void run(() => createBackup(password), 'Резервная копия сохранена на сервере.')
            }>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Сохранить копию</Text>}
          </Pressable>
        </View>
      )}

      {needsRestore && stale && (
        <View style={s.card}>
          <Text style={s.title}>Копия от другого ключа</Text>
          <Text style={s.hint}>
            Пароль подошёл, но в копии ключ{' '}
            <Text style={s.mono}>{shortKeyId(stale.backupPublicKey)}</Text>, а у аккаунта сейчас{' '}
            <Text style={s.mono}>{shortKeyId(stale.accountPublicKey)}</Text> — его создало другое
            устройство.
          </Text>
          <Text style={s.hint}>
            Можно сделать ключ из копии ключом аккаунта: вернётся переписка, зашифрованная этим
            ключом. Сообщения, зашифрованные ключом{' '}
            <Text style={s.mono}>{shortKeyId(stale.accountPublicKey)}</Text>, останутся читаемыми
            только на том устройстве; на остальных ключи нужно будет восстановить из этой копии.
          </Text>
          <TextInput
            style={s.input}
            placeholder="Пароль аккаунта"
            placeholderTextColor="#555"
            secureTextEntry
            autoCapitalize="none"
            value={adoptPassword}
            onChangeText={setAdoptPassword}
            editable={!busy}
          />
          <Pressable
            style={[s.primary, (busy || adoptPassword.length < 8) && s.disabled]}
            disabled={busy || adoptPassword.length < 8}
            onPress={() =>
              void run(() => adoptBackup(stale.backupPassword, adoptPassword))
            }>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.primaryText}>Сделать ключом аккаунта</Text>
            )}
          </Pressable>
        </View>
      )}

      <View style={s.card}>
        <Text style={s.title}>
          {needsRestore ? 'Нет ни копии, ни доступа к другим устройствам?' : 'Сменить ключи'}
        </Text>
        <Text style={s.hint}>
          Новые ключи аккаунта. Переписка, зашифрованная старым ключом, на новых устройствах
          не прочитается, а на остальных ваших устройствах ключи придётся восстановить заново.
          Собеседники увидят предупреждение о смене ключа.
        </Text>
        <TextInput
          style={s.input}
          placeholder="Пароль аккаунта"
          placeholderTextColor="#555"
          secureTextEntry
          autoCapitalize="none"
          value={accountPassword}
          onChangeText={setAccountPassword}
          editable={!busy}
        />
        <Pressable
          style={[s.danger, (busy || accountPassword.length < 8) && s.disabled]}
          disabled={busy || accountPassword.length < 8}
          onPress={() =>
            void run(
              () => rotate(accountPassword),
              'Ключи обновлены. Создайте новую резервную копию — без неё другие устройства не смогут читать новые сообщения.',
            )
          }>
          <Text style={s.dangerText}>Создать новые ключи</Text>
        </Pressable>
      </View>

      {notice && <Text style={s.ok}>{notice}</Text>}
      {error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
  content: {padding: 16, gap: 16},
  card: {
    backgroundColor: '#1a1d27',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  title: {color: '#e0e0e0', fontSize: 16, fontWeight: '600'},
  lead: {color: '#9ca3af', fontSize: 13, lineHeight: 19},
  hint: {color: '#9ca3af', fontSize: 12, lineHeight: 17},
  warn: {color: '#fbbf24', fontSize: 13, lineHeight: 19},
  mono: {fontFamily: 'monospace', color: '#c4b5fd'},
  input: {
    backgroundColor: '#0f1117',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e0e0e0',
    fontSize: 14,
  },
  primary: {
    backgroundColor: '#6c63ff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  primaryText: {color: '#fff', fontWeight: '700', fontSize: 15},
  secondary: {
    backgroundColor: '#2a2d3a',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  secondaryText: {color: '#e0e0e0', fontWeight: '600', fontSize: 15},
  danger: {
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  dangerText: {color: '#fecaca', fontWeight: '600', fontSize: 15},
  disabled: {opacity: 0.5},
  ok: {color: '#6ee7a0', fontSize: 13, lineHeight: 19},
  error: {color: '#ff6b6b', fontSize: 13, lineHeight: 19},
});
