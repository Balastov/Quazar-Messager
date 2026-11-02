import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Image, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {authApi} from '../api/auth';
import {phoneVerificationApi} from '../api/phoneVerification';
import {forgetVerifier, parseReturnUrl, startYandexLogin, storedVerifier} from '../auth/yandex';
import {useAuthStore} from '../store/auth';
import {formatRuPhoneMask, isCompleteRuPhone, toE164Ru} from '../utils/phone';
import {apiErrorText, USERNAME_MAX} from '../utils/profile';
import {useUsernameCheck} from '../hooks/useUsernameCheck';
import PhoneVisibilityChoice from '../components/PhoneVisibilityChoice';
import ForgotPassword from '../components/ForgotPassword';
import PhoneVerification from '../components/PhoneVerification';

type Mode = 'login' | 'register' | 'profile' | 'yandex';
export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [phone, setPhone] = useState('+7'), [username, setUsername] = useState('');
  const [password, setPassword] = useState(''), [legacy, setLegacy] = useState(false);
  const [passwordAllowed, setPasswordAllowed] = useState(false);
  const [proof, setProof] = useState<string>();
  const [firstName, setFirstName] = useState(''), [lastName, setLastName] = useState(''), [email, setEmail] = useState('');
  const [discoverable, setDiscoverable] = useState<boolean | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [yandex, setYandex] = useState(false);
  const [round, setRound] = useState(0);
  const [yandexCode, setYandexCode] = useState<{code: string; verifier: string} | null>(null);
  const handled = useRef<string | null>(null);
  const setToken = useAuthStore(st => st.setToken);
  const profile = mode === 'profile' || (mode === 'yandex' && !!proof);
  const check = useUsernameCheck(profile ? username : '');
  const e164 = isCompleteRuPhone(phone) ? toE164Ru(phone) : null;
  useEffect(() => {
    void authApi.providers().then(p => setYandex(p.yandex)).catch(() => {});
    const onUrl = async (url: string | null) => {
      const params = parseReturnUrl(url);
      if (!params || handled.current === url) {return;}
      handled.current = url;
      if (params.error || !params.code) {setError('Вход через Яндекс не завершён. Повторите попытку.'); return;}
      const verifier = await storedVerifier();
      if (!verifier) {setError('Время входа истекло. Повторите попытку.'); return;}
      setLoading(true); setError('');
      try {
        const result = await authApi.yandexExchange(params.code, verifier);
        if (result.status === 'login') {await forgetVerifier(); await setToken(result.access_token); return;}
        setUsername(result.profile.username ?? ''); setPhone(result.profile.phone ? formatRuPhoneMask(result.profile.phone) : '+7');
        setFirstName(result.profile.first_name ?? ''); setLastName(result.profile.last_name ?? '');
        setProof(undefined); setDiscoverable(null); setYandexCode({code: params.code, verifier}); setMode('yandex');
      } catch (err) {setError(apiErrorText(err));}
      finally {setLoading(false);}
    };
    const sub = Linking.addEventListener('url', event => void onUrl(event.url));
    void Linking.getInitialURL().then(onUrl);
    return () => sub.remove();
  }, [setToken]);
  useEffect(() => {
    let active = true;
    setPasswordAllowed(false); setLegacy(false); setPassword('');
    if (!e164 || mode !== 'login') {return;}
    const timer = setTimeout(() => {
      void authApi.phoneOptions(e164).then(result => {if (active) {setPasswordAllowed(result.password_login_allowed);}})
        .catch(() => {if (active) {setError('Не удалось проверить способы входа. Повторите попытку.');}});
    }, 300);
    return () => {active = false; clearTimeout(timer);};
  }, [e164, mode]);
  const changeMode = (value: Mode) => {setMode(value); setError(''); setLegacy(false);};
  const submit = async () => {
    if (!e164 || loading) {return;}
    setLoading(true); setError('');
    try {
      if (mode === 'login' && legacy) {await setToken((await authApi.login(e164, password)).access_token);}
      else if (profile && proof && discoverable !== null) {
        const body = {username: username.trim().replace(/^@/, ''), phone: e164, phone_discoverable: discoverable,
          phone_verification_token: proof, first_name: firstName, last_name: lastName};
        const result = mode === 'yandex' && yandexCode
          ? await authApi.yandexComplete({...body, ...yandexCode}) : await authApi.register({...body, email});
        if (mode === 'yandex') {await forgetVerifier();}
        await setToken(result.access_token);
      }
    } catch (err) {
      const text = apiErrorText(err); setError(text);
      if (/Подтвердите телефон/.test(text)) {setProof(undefined); if (mode !== 'yandex') {setMode('register');}}
    } finally {setLoading(false);}
  };
  return <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled"><View style={s.card}>
      <Image style={s.logoMark} source={require('../assets/logo-mark.png')} />
      <Text style={s.title}>{profile ? 'Как вас представить?' : mode === 'login' ? 'Вход' : 'Регистрация без пароля'}</Text>
      {!profile && mode !== 'yandex' && <View style={s.tabs}>
        {(['login', 'register'] as const).map(value => <Pressable key={value} style={[s.tab, mode === value && s.activeTab]} onPress={() => changeMode(value)}>
          <Text style={s.tabText}>{value === 'login' ? 'Войти' : 'Создать аккаунт'}</Text></Pressable>)}
      </View>}
      {profile ? <>
        <Text style={s.hint}>✓ Телефон {phone} подтверждён</Text>
        <TextInput style={s.input} placeholder="никнейм" placeholderTextColor="#888" value={username} onChangeText={value => setUsername(value.replace(/\s/g, ''))}
          maxLength={USERNAME_MAX + 1} autoCapitalize="none" autoCorrect={false} />
        <Text style={s.hint}>{check.state === 'bad' ? check.message : 'Латиницей: по нему вас найдут и @упомянут'}</Text>
        <TextInput style={s.input} placeholder="Имя — необязательно" placeholderTextColor="#888" value={firstName} onChangeText={setFirstName} maxLength={64} />
        <TextInput style={s.input} placeholder="Фамилия — необязательно" placeholderTextColor="#888" value={lastName} onChangeText={setLastName} maxLength={64} />
        {mode !== 'yandex' && <TextInput style={s.input} placeholder="Почта — необязательно" placeholderTextColor="#888" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />}
        <PhoneVisibilityChoice value={discoverable} onChange={setDiscoverable} />
        <Pressable style={[s.submit, (loading || !proof || check.state !== 'ok' || discoverable === null) && s.disabled]}
          disabled={loading || !proof || check.state !== 'ok' || discoverable === null} onPress={() => void submit()}><Text style={s.submitText}>Создать аккаунт</Text></Pressable>
        <Pressable style={s.skip} onPress={() => {setProof(undefined); if (mode !== 'yandex') {setMode('register');}}}><Text style={s.skipText}>Изменить номер</Text></Pressable>
      </> : <>
        <TextInput style={s.input} placeholder="+7 (999) 000-00-00" placeholderTextColor="#888" value={phone} keyboardType="phone-pad"
          onChangeText={value => {setPhone(formatRuPhoneMask(value)); setProof(undefined); setError('');}} />
        {legacy && mode === 'login' ? <>
          <TextInput style={s.input} placeholder="Пароль" placeholderTextColor="#888" value={password} onChangeText={setPassword} secureTextEntry />
          <Pressable style={s.submit} disabled={loading || !password} onPress={() => void submit()}><Text style={s.submitText}>Войти</Text></Pressable>
          <ForgotPassword initialLogin={e164 ?? ''} />
          <Pressable style={s.skip} onPress={() => setLegacy(false)}><Text style={s.skipText}>Вернуться ко входу звонком</Text></Pressable>
        </> : <>
          {e164 && <PhoneVerification key={`${mode}:${e164}:${round}`} phone={e164} account={mode === 'login' ? 'login' : false}
            buttonLabel={mode === 'login' ? 'Войти звонком' : 'Подтвердить телефон звонком'} onVerified={token => {
              if (mode === 'login') {
                setLoading(true);
                void phoneVerificationApi.completeLogin(token).then(result => setToken(result.access_token)).catch(err => {setError(apiErrorText(err)); setRound(value => value + 1);})
                  .finally(() => setLoading(false));
              } else {setProof(token); if (mode !== 'yandex') {setMode('profile');}}
            }} />}
          {mode === 'login' && passwordAllowed && <Pressable style={s.skip} onPress={() => setLegacy(true)}><Text style={s.skipText}>Войти паролем — старый аккаунт</Text></Pressable>}
        </>}
      </>}
      {!!error && <Text style={s.error}>{error}</Text>}
      {loading && <ActivityIndicator color="#34d399" />}
      {yandex && !profile && <Pressable style={s.yandex} disabled={loading} onPress={() => void startYandexLogin().catch(() => setError('Не получилось открыть Яндекс ID'))}>
        <Text style={s.yandexText}>Войти с Яндекс ID</Text></Pressable>}
      {mode === 'yandex' && <Pressable style={s.skip} onPress={() => changeMode('login')}><Text style={s.skipText}>Вернуться ко входу</Text></Pressable>}
    </View></ScrollView>
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117', alignItems: 'center', justifyContent: 'center'},
  card: {width: '88%', maxWidth: 360},
  scroll: {flex: 1, width: '100%'},
  scrollContent: {flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24},
  logoMark: {width: 88, height: 88, alignSelf: 'center', marginBottom: 8},
  logo: {
    fontSize: 32,
    fontWeight: '700',
    color: '#6c63ff',
    textAlign: 'center',
    letterSpacing: 2,
    marginBottom: 32,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#0f1117',
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 20,
  },
  tab: {flex: 1, paddingVertical: 11, alignItems: 'center'},
  activeTab: {backgroundColor: '#6c63ff'},
  tabText: {color: '#888', fontWeight: '600', fontSize: 14},
  activeTabText: {color: '#fff'},
  input: {
    backgroundColor: '#1a1d27',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e0e0e0',
    fontSize: 14,
    marginBottom: 12,
  },
  error: {color: '#ff6b6b', fontSize: 13, marginBottom: 10},
  nickInput: {marginBottom: 4},
  choice: {borderTopWidth: 1, borderTopColor: '#2a2d3a', paddingTop: 14, marginTop: 2, marginBottom: 14},
  hint: {color: '#888', fontSize: 12, marginBottom: 12, marginLeft: 2},
  hintOk: {color: '#4ade80'},
  hintBad: {color: '#ff6b6b'},
  back: {color: '#888', fontSize: 13, marginBottom: 16},
  title: {color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 6},
  lead: {color: '#9b93b8', fontSize: 13, lineHeight: 18, marginBottom: 16},
  skip: {alignItems: 'center', paddingVertical: 12},
  skipText: {color: '#888', fontSize: 14},
  submit: {
    backgroundColor: '#6c63ff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  disabled: {opacity: 0.5},
  submitText: {color: '#fff', fontWeight: '700', fontSize: 15},
  // «Войти с Яндекс ID» — по правилам бренда: тёмная кнопка, красная «Я».
  yandex: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 10,
    paddingVertical: 13,
    marginTop: 12,
  },
  yandexMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fc3f1d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  yandexMarkText: {color: '#fff', fontWeight: '700', fontSize: 14},
  yandexText: {color: '#fff', fontWeight: '600', fontSize: 15},
});
