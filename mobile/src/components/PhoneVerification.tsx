import React, {useEffect, useRef, useState} from 'react';
import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import {phoneVerificationApi, type PhoneVerification as Attempt, type PhoneMode} from '../api/phoneVerification';
import {useAuthStore} from '../store/auth';
import {apiErrorText} from '../utils/profile';

export default function PhoneVerification({phone, account = false, proof, onVerified, buttonLabel = 'Подтвердить телефон звонком'}: {
  phone: string; account?: PhoneMode; proof?: string; onVerified: (token: string) => void; buttonLabel?: string;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const round = useRef(0), callback = useRef(onVerified); callback.current = onVerified;
  const previousProof = useRef(proof);
  useEffect(() => {
    if (previousProof.current && !proof) {setAttempt(null);}
    previousProof.current = proof;
  }, [proof]);
  useEffect(() => {
    round.current++; setAttempt(null); setBusy(false); setError('');
    return () => {round.current++;};
  }, [phone, account]);
  useEffect(() => {
    if (!attempt?.verification_token || attempt.state !== 'pending') {return;}
    const token = attempt.verification_token, current = round.current;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await phoneVerificationApi.status(token, account);
        if (!active || current !== round.current) {return;}
        if (result.access_token) {await useAuthStore.getState().refreshSession(result.access_token);}
        if (!active || current !== round.current) {return;}
        setError(''); setAttempt({...result, verification_token: token});
        if (result.state === 'verified') {callback.current(token);}
        else if (result.state === 'pending') {timer = setTimeout(poll, 4000);}
      } catch (err) {
        if (!active || current !== round.current) {return;}
        setError(apiErrorText(err, 'Не удалось проверить звонок')); timer = setTimeout(poll, 8000);
      }
    };
    timer = setTimeout(poll, 4000);
    return () => {active = false; clearTimeout(timer);};
  }, [attempt?.verification_token, attempt?.state, account]);
  const start = async () => {
    if (busy) {return;}
    const current = ++round.current;
    setBusy(true); setError(''); setAttempt(null);
    try {
      const result = await phoneVerificationApi.start(phone, account);
      if (current === round.current) {setAttempt(result);}
    } catch (err) {if (current === round.current) {setError(apiErrorText(err));}}
    finally {if (current === round.current) {setBusy(false);}}
  };
  if (proof || attempt?.state === 'verified') {return <Text style={s.success}>✓ Телефон подтверждён</Text>;}
  return <View style={s.root}>
    {attempt?.state === 'pending' ? <>
      <Text style={s.hint}>Позвоните с {phone} на проверочный номер. Разговаривать и вводить код не нужно.</Text>
      {!!attempt.call_phone && <Pressable style={s.button} onPress={() => {
        void Linking.openURL(`tel:${attempt.call_phone}`).catch(() => setError('Не удалось открыть приложение для звонков'));
      }}><Text style={s.success}>Позвонить: {attempt.call_phone}</Text></Pressable>}
      <Text style={s.hint}>Ждём звонок. При двух SIM-картах выберите SIM с указанным номером.</Text>
    </> : <>
      {!!attempt && <Text style={s.hint}>{attempt.state === 'expired' ? 'Время проверки истекло.' : 'Номер не подтверждён.'}</Text>}
      <Pressable style={s.button} disabled={busy} onPress={() => void start()}>
        <Text style={s.success}>{busy ? 'Подготавливаем проверку…' : buttonLabel}</Text>
      </Pressable>
    </>}
    {!!error && <Text style={s.error}>{error}</Text>}
  </View>;
}
const s = StyleSheet.create({
  root: {gap: 10, marginVertical: 10}, hint: {color: '#9b93b8', fontSize: 13},
  success: {color: '#34d399'}, error: {color: '#f87171'},
  button: {padding: 12, borderWidth: 1, borderColor: '#34d399', borderRadius: 12, alignItems: 'center'},
});
