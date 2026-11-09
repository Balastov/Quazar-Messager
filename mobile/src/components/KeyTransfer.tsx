import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import axios from 'axios';
import {devicesApi, type PairView} from '../api/devices';
import {
  checkPairUpdate,
  displayPairCode,
  openDeviceKeys,
  pairBinding,
  pairKeys,
  receiverSecret,
  sealDeviceKeys,
} from '../crypto/deviceTransfer';
import {decodeB64} from '../crypto/base64';
import {importTransferredIdentity, loadKeys} from '../crypto/keys';
import {useE2EStore} from '../store/e2e';

function errorText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') {return detail;}
    if (!err.response) {return 'Нет связи с сервером';}
  }
  return err instanceof Error ? err.message : fallback;
}

const deviceName = () => `Quazar · ${Platform.OS === 'ios' ? 'iPhone' : 'Android'}`;
const expiredAt = (flow: PairView) => Date.parse(flow.expires_at) <= Date.now();

function Expiry({flow}: {flow: PairView}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(flow.expires_at) - now) / 1000));
  return <Text style={s.hint}>{seconds ? `Осталось ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Время истекло'}</Text>;
}

/** Этот телефон уже вошёл, но ключа переписки нет: показываем код для другого устройства. */
export function KeyReceiverCard({userId}: {userId: string}) {
  const [round, setRound] = useState(0);
  const [started, setStarted] = useState(false);
  return (
    <View style={s.card}>
      <Text style={s.title}>С другого своего устройства</Text>
      <Text style={s.hint}>
        Подходит, если Quazar открыт там, где личные сообщения читаются: в браузере, в приложении на
        компьютере или на другом телефоне. Пароль не нужен.
      </Text>
      {started ? (
        <KeyReceiveAttempt key={round} userId={userId} onRestart={() => setRound(value => value + 1)} />
      ) : (
        <Pressable style={s.primary} onPress={() => setStarted(true)}>
          <Text style={s.primaryText}>Получить ключи с другого устройства</Text>
        </Pressable>
      )}
    </View>
  );
}

function KeyReceiveAttempt({userId, onRestart}: {userId: string; onRestart(): void}) {
  const [keys] = useState(pairKeys);
  const [secret] = useState(receiverSecret);
  const [flow, setFlow] = useState<PairView | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const row = useRef<PairView | null>(null);
  const alive = useRef(true);
  const finishing = useRef(false);
  const accept = (value: PairView) => {
    const next = checkPairUpdate(row.current, value, keys, true);
    row.current = next;
    setFlow(next);
  };

  useEffect(() => {
    alive.current = true;
    devicesApi
      .requestKeys({public_key: keys.publicKey, receiver_secret: secret, device_name: deviceName()})
      .then(result => {
        if (!alive.current) {return;}
        accept(result.request);
        setCode(result.code);
      })
      .catch(err => alive.current && setError(errorText(err, 'Не удалось начать передачу ключей')));
    return () => {
      alive.current = false;
      const last = row.current;
      keys.secretKey.fill(0);
      if (last && ['pending', 'claimed', 'approved'].includes(last.state)) {
        devicesApi.cancel(last.id, secret).catch(() => {});
      }
    };
    // Запрос создаётся один раз на попытку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!flow || !['pending', 'claimed'].includes(flow.state)) {return;}
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (expiredAt(flow)) {
        if (active) {setFlow(value => value && {...value, state: 'expired'});}
        return;
      }
      try {
        const value = await devicesApi.status(flow.id, secret);
        if (!active) {return;}
        accept(value);
        setError('');
      } catch (err) {
        if (active) {setError(errorText(err, 'Не удалось проверить запрос'));}
      }
      if (active) {timer = setTimeout(poll, 2000);}
    };
    timer = setTimeout(poll, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.id, flow?.state]);

  useEffect(() => {
    if (flow?.state !== 'approved' || finishing.current) {return;}
    finishing.current = true;
    const expected = flow;
    (async () => {
      setSaving(true);
      setError('');
      try {
        const result = await devicesApi.consumeKeys(expected.id, secret);
        const done = checkPairUpdate(expected, result.request, keys, true);
        if (!result.encrypted_keys) {throw new Error('Ключи не пришли. Повторите передачу');}
        if (done.account?.id !== userId) {throw new Error('Ключи относятся к другому аккаунту');}
        const transferred = openDeviceKeys(result.encrypted_keys, done, keys);
        try {
          await importTransferredIdentity(transferred.seed, transferred.archived);
        } finally {
          transferred.seed.fill(0);
          transferred.archived.forEach(value => value.fill(0));
        }
        row.current = done;
        if (alive.current) {setFlow(done);}
        await useE2EStore.getState().sync(userId);
      } catch (err) {
        finishing.current = false;
        if (alive.current) {setError(errorText(err, 'Не удалось сохранить ключи'));}
      } finally {
        if (alive.current) {setSaving(false);}
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.state]);

  const expired = flow && (flow.state === 'expired' || (flow.state !== 'consumed' && expiredAt(flow)));
  return (
    <View style={s.stack}>
      {!flow && !error && <ActivityIndicator color="#6c63ff" />}
      {flow && !expired && flow.state !== 'rejected' && (
        <>
          {flow.state === 'pending' ? (
            <>
              <Text style={s.hint}>
                На устройстве, где переписка читается, введите этот код: в браузере или приложении
                на компьютере — «Настройки → Устройства → Подключить по QR или коду», на другом
                телефоне — «Профиль → Ключи шифрования → Передать ключи».
              </Text>
              <Text style={s.code} accessibilityLabel="Одноразовый код">
                {code.slice(0, 4)}-{code.slice(4)}
              </Text>
            </>
          ) : (
            <>
              <Text style={s.hint}>Сверьте код с экраном другого устройства и подтвердите передачу там.</Text>
              <Text style={s.code} accessibilityLabel="Код сравнения">{displayPairCode(pairBinding(flow))}</Text>
              <Text style={s.hint}>
                {saving ? 'Сохраняем ключи…' : flow.state === 'consumed' ? 'Ключи получены' : 'Ждём подтверждение на другом устройстве…'}
              </Text>
            </>
          )}
          {flow.state !== 'consumed' && <Expiry flow={flow} />}
        </>
      )}
      {(expired || flow?.state === 'rejected') && (
        <Text style={s.hint}>{flow?.state === 'rejected' ? 'Передача отменена' : 'Время запроса истекло'}</Text>
      )}
      {!!error && <Text style={s.error}>{error}</Text>}
      {(expired || !!error || flow?.state === 'rejected') && (
        <Pressable style={s.secondary} onPress={onRestart}>
          <Text style={s.secondaryText}>Новый код</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Здесь ключ есть: передаём его своему устройству, которое показало одноразовый код. */
export function KeyApproverCard() {
  const [round, setRound] = useState(0);
  return (
    <View style={s.card}>
      <Text style={s.title}>Передать ключи на другое устройство</Text>
      <Text style={s.hint}>
        Если на другом своём устройстве вы уже вошли, но личные сообщения там не читаются, нажмите
        там «Получить ключи с другого устройства» и введите показанный код здесь.
      </Text>
      <KeyApproveAttempt key={round} onRestart={() => setRound(value => value + 1)} />
    </View>
  );
}

function KeyApproveAttempt({onRestart}: {onRestart(): void}) {
  const [keys] = useState(pairKeys);
  const [code, setCode] = useState('');
  const [flow, setFlow] = useState<PairView | null>(null);
  const [matches, setMatches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const row = useRef<PairView | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const last = row.current;
      keys.secretKey.fill(0);
      if (last?.state === 'claimed') {devicesApi.reject(last.id).catch(() => {});}
    };
  }, [keys]);

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const value = await devicesApi.claim({public_key: keys.publicKey, code});
      const next = checkPairUpdate(null, value, keys, false);
      row.current = next;
      if (alive.current) {setFlow(next);}
    } catch (err) {
      if (alive.current) {setError(errorText(err, 'Код не подошёл'));}
    } finally {
      if (alive.current) {setBusy(false);}
    }
  };

  const approve = async () => {
    if (!flow) {return;}
    setBusy(true);
    setError('');
    try {
      const identity = await loadKeys();
      if (!identity) {throw new Error('На этом устройстве нет ключа переписки');}
      const secret = decodeB64(identity.privateKey);
      try {
        const sealed = sealDeviceKeys(flow, keys, secret);
        const value = await devicesApi.approve(flow.id, pairBinding(flow), sealed);
        const next = checkPairUpdate(row.current, value, keys, false);
        row.current = next;
        if (alive.current) {setFlow(next);}
      } finally {
        secret.fill(0);
      }
    } catch (err) {
      if (alive.current) {setError(errorText(err, 'Не удалось передать ключи'));}
    } finally {
      if (alive.current) {setBusy(false);}
    }
  };

  if (flow && ['approved', 'consumed'].includes(flow.state)) {
    return (
      <View style={s.stack}>
        <Text style={s.ok}>
          {flow.kind === 'keys'
            ? `Ключи переданы на «${flow.device_name}». Там переписка откроется через несколько секунд.`
            : `Вход разрешён. Завершите его на «${flow.device_name}».`}
        </Text>
        <Pressable style={s.secondary} onPress={onRestart}>
          <Text style={s.secondaryText}>Готово</Text>
        </Pressable>
      </View>
    );
  }

  if (flow) {
    return (
      <View style={s.stack}>
        <Text style={s.hint}>
          {flow.kind === 'keys' ? 'Ключи просит: ' : 'Входит в ваш аккаунт: '}
          <Text style={s.strong}>{flow.device_name}</Text>. Подтверждайте только своё устройство.
        </Text>
        <Text style={s.code} accessibilityLabel="Код сравнения">{displayPairCode(pairBinding(flow))}</Text>
        <View style={s.row}>
          <Switch value={matches} onValueChange={setMatches} disabled={busy} />
          <Text style={[s.hint, s.flex]}>Код на обоих устройствах совпадает</Text>
        </View>
        <Pressable style={[s.primary, (busy || !matches) && s.disabled]} disabled={busy || !matches} onPress={() => void approve()}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.primaryText}>{flow.kind === 'keys' ? 'Передать ключи' : 'Это моё устройство — разрешить вход'}</Text>
          )}
        </Pressable>
        <Expiry flow={flow} />
        {!!error && <Text style={s.error}>{error}</Text>}
        <Pressable style={s.secondary} onPress={onRestart} disabled={busy}>
          <Text style={s.secondaryText}>Отмена</Text>
        </Pressable>
      </View>
    );
  }

  const ready = code.replace(/[ -]/g, '').length === 8;
  return (
    <View style={s.stack}>
      <TextInput
        style={s.input}
        placeholder="ABCD-EFGH"
        placeholderTextColor="#555"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        maxLength={20}
        value={code}
        onChangeText={value => setCode(value.toUpperCase())}
        editable={!busy}
        accessibilityLabel="Одноразовый код"
      />
      <Pressable style={[s.primary, (busy || !ready) && s.disabled]} disabled={busy || !ready} onPress={() => void claim()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Продолжить</Text>}
      </Pressable>
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  card: {backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2a2d3a', borderRadius: 14, padding: 16, gap: 10},
  stack: {gap: 10},
  row: {flexDirection: 'row', alignItems: 'center', gap: 10},
  flex: {flex: 1},
  title: {color: '#e0e0e0', fontSize: 16, fontWeight: '600'},
  hint: {color: '#9ca3af', fontSize: 12, lineHeight: 17},
  strong: {color: '#e0e0e0', fontWeight: '600'},
  code: {color: '#c4b5fd', fontFamily: 'monospace', fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: 2},
  input: {
    backgroundColor: '#0f1117', borderWidth: 1, borderColor: '#2a2d3a', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, color: '#e0e0e0', fontSize: 16, letterSpacing: 2,
  },
  primary: {backgroundColor: '#6c63ff', borderRadius: 10, paddingVertical: 13, alignItems: 'center'},
  primaryText: {color: '#fff', fontWeight: '700', fontSize: 15},
  secondary: {backgroundColor: '#2a2d3a', borderRadius: 10, paddingVertical: 13, alignItems: 'center'},
  secondaryText: {color: '#e0e0e0', fontWeight: '600', fontSize: 15},
  disabled: {opacity: 0.5},
  ok: {color: '#6ee7a0', fontSize: 13, lineHeight: 19},
  error: {color: '#ff6b6b', fontSize: 13, lineHeight: 19},
});
