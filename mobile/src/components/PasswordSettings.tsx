import React, {useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {authApi} from '../api/auth';
import {useAuthStore} from '../store/auth';
import {apiErrorText} from '../utils/profile';

export default function PasswordSettings() {
  const hasPassword = useAuthStore(state => state.user?.has_password !== false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  if (!hasPassword) {return null;}
  const valid = current.length > 0 && Array.from(next).length >= 8 && !!next.trim() && next === confirmation;
  const change = async () => {
    if (!valid || busy) {return;}
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await authApi.changePassword(current, next, confirmation);
      if (result?.access_token) {await useAuthStore.getState().refreshSession(result.access_token);}
      setCurrent(''); setNext(''); setConfirmation(''); setOpen(false); setMessage('Пароль изменён');
    } catch (err) {setError(apiErrorText(err, 'Не удалось изменить пароль'));}
    finally {setBusy(false);}
  };
  return <View style={s.root}>
    <Text style={s.title}>Пароль</Text>
    {open ? <>
      <TextInput style={s.input} placeholder="Старый пароль" placeholderTextColor="#9b93b8" secureTextEntry
        value={current} onChangeText={setCurrent} editable={!busy} textContentType="password" autoCapitalize="none" />
      <TextInput style={s.input} placeholder="Новый пароль, от 8 символов" placeholderTextColor="#9b93b8" secureTextEntry
        value={next} onChangeText={setNext} editable={!busy} textContentType="newPassword" maxLength={72} autoCapitalize="none" />
      <TextInput style={s.input} placeholder="Повторите новый пароль" placeholderTextColor="#9b93b8" secureTextEntry
        value={confirmation} onChangeText={setConfirmation} editable={!busy} textContentType="newPassword" maxLength={72} autoCapitalize="none" />
      {!!confirmation && confirmation !== next && <Text style={s.error}>Новые пароли не совпадают</Text>}
      <Pressable style={[s.button, (!valid || busy) && s.disabled]} disabled={!valid || busy} onPress={() => void change()}>
        {busy ? <ActivityIndicator color="#34d399" /> : <Text style={s.buttonText}>Изменить пароль</Text>}
      </Pressable>
      <Pressable disabled={busy} onPress={() => {setOpen(false); setCurrent(''); setNext(''); setConfirmation(''); setError('');}}>
        <Text style={s.hint}>Отмена</Text>
      </Pressable>
    </> : <Pressable style={s.button} onPress={() => {setOpen(true); setMessage(''); setError('');}}>
      <Text style={s.buttonText}>Изменить пароль</Text>
    </Pressable>}
    {!!message && <Text style={s.hint}>{message}</Text>}
    {!!error && <Text style={s.error}>{error}</Text>}
  </View>;
}

const s = StyleSheet.create({
  root: {gap: 10, padding: 16, borderRadius: 18, backgroundColor: '#161028', marginBottom: 12},
  title: {fontSize: 16, fontWeight: '600', color: '#f4f1ff'},
  input: {padding: 12, fontSize: 16, borderWidth: 1, borderColor: '#493666', borderRadius: 10, color: '#f4f1ff'},
  button: {padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#34d399', alignItems: 'center'},
  buttonText: {color: '#34d399', fontWeight: '600'}, hint: {color: '#9b93b8', fontSize: 13},
  error: {color: '#f87171', fontSize: 13}, disabled: {opacity: 0.4},
});
