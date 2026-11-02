import React, {useRef, useState} from 'react';
import {ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {authApi} from '../api/auth';
import {apiErrorText} from '../utils/profile';

export default function ForgotPassword({initialLogin = ''}: {initialLogin?: string}) {
  const [visible, setVisible] = useState(false);
  const [login, setLogin] = useState(initialLogin);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const close = () => {generation.current++; setVisible(false); setBusy(false);};
  const submit = async () => {
    if (busy || !login.trim()) {return;}
    const request = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await authApi.forgotPassword(login.trim());
      if (request === generation.current) {setMessage(result.message);}
    } catch (err) {
      if (request === generation.current) {setError(apiErrorText(err, 'Не удалось отправить запрос'));}
    } finally {if (request === generation.current) {setBusy(false);}}
  };
  return <>
    <Pressable onPress={() => {generation.current++; setLogin(initialLogin); setMessage(''); setError(''); setBusy(false); setVisible(true);}}>
      <Text style={s.link}>Забыл пароль</Text>
    </Pressable>
    <Modal visible={visible} animationType="fade" transparent onRequestClose={close}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.card}>
            <Text style={s.title}>Забыл пароль</Text>
            {message ? <>
              <Text style={s.hint}>{message}</Text>
              <Pressable style={s.button} onPress={close}><Text style={s.link}>Вернуться ко входу</Text></Pressable>
            </> : <>
              <Text style={s.hint}>Укажите никнейм или номер телефона аккаунта. Администратор получит запрос на восстановление доступа.</Text>
              <TextInput style={s.input} placeholder="Никнейм или номер телефона" placeholderTextColor="#9b93b8"
                value={login} onChangeText={setLogin} editable={!busy} maxLength={128} autoCapitalize="none" autoCorrect={false}
                textContentType="username" accessibilityLabel="Логин для восстановления" />
              {!!error && <Text style={s.error}>{error}</Text>}
              <Pressable style={[s.button, (busy || !login.trim()) && s.disabled]} disabled={busy || !login.trim()} onPress={() => void submit()}>
                {busy ? <ActivityIndicator color="#34d399" /> : <Text style={s.link}>Отправить запрос</Text>}
              </Pressable>
              <Pressable onPress={close}><Text style={s.hint}>Отмена</Text></Pressable>
            </>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  </>;
}
const s = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(4,3,12,0.85)'}, scroll: {flexGrow: 1, justifyContent: 'center', padding: 20},
  card: {padding: 20, gap: 14, backgroundColor: '#161028', borderRadius: 18}, title: {color: '#f4f1ff', fontSize: 20, fontWeight: '600'},
  input: {padding: 12, color: '#f4f1ff', fontSize: 16, borderRadius: 10, borderWidth: 1, borderColor: '#493666'},
  hint: {color: '#9b93b8', fontSize: 14, lineHeight: 20}, error: {color: '#f87171', fontSize: 13},
  button: {padding: 12, borderWidth: 1, borderColor: '#34d399', borderRadius: 10, alignItems: 'center'},
  link: {color: '#34d399', fontWeight: '600', fontSize: 14}, disabled: {opacity: 0.4},
});
