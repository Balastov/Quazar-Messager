import React, {useState} from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {authApi} from '../api/auth';
import {useAuthStore} from '../store/auth';
import {formatRuPhoneMask, isCompleteRuPhone, toE164Ru} from '../utils/phone';
import {apiErrorText, USERNAME_MAX} from '../utils/profile';
import {useUsernameCheck} from '../hooks/useUsernameCheck';
import PhoneVisibilityChoice from '../components/PhoneVisibilityChoice';

// register — обязательное (телефон, никнейм, пароль); about — предлагаем имя и почту.
type Mode = 'login' | 'register' | 'about';

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  // Без значения по умолчанию: «Да» или «Нет» человек выбирает сам.
  const [phoneDiscoverable, setPhoneDiscoverable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const check = useUsernameCheck(mode === 'register' ? username : '');

  const setToken = useAuthStore(s => s.setToken);
  const nick = username.trim().replace(/^@/, '');

  const switchMode = (next: Mode) => {
    setError('');
    setMode(next);
  };

  const login = async () => {
    setError('');
    const e164 = toE164Ru(phone);
    if (!e164 || !isCompleteRuPhone(phone)) {
      setError('Введите номер в формате +7 (999) 000-00-00');
      return;
    }
    setLoading(true);
    try {
      const data = await authApi.login(e164, password);
      await setToken(data.access_token);
    } catch (err: unknown) {
      setError(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  };

  const toAbout = () => {
    setError('');
    if (!isCompleteRuPhone(phone)) {
      setError('Введите номер в формате +7 (999) 000-00-00');
    } else if (check.state === 'bad') {
      setError(check.message);
    } else if (password.length < 8) {
      setError('Пароль — не короче 8 символов');
    } else if (phoneDiscoverable === null) {
      setError('Выберите, можно ли найти вас по номеру');
    } else {
      setMode('about');
    }
  };

  const register = async (withAbout: boolean) => {
    setError('');
    setLoading(true);
    try {
      const data = await authApi.register({
        username: nick,
        phone: toE164Ru(phone)!,
        password,
        phone_discoverable: phoneDiscoverable!,
        ...(withAbout ? {first_name: firstName, last_name: lastName, email} : {}),
      });
      await setToken(data.access_token);
    } catch (err: unknown) {
      const text = apiErrorText(err);
      setError(text);
      // Номер или никнейм успели занять — это поля первого шага.
      if (/номер|никнейм|Phone|ароль/i.test(text)) {
        setMode('register');
      }
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'about') {
    const hasAbout = !!(firstName.trim() || lastName.trim() || email.trim());
    return (
      <KeyboardAvoidingView
        style={s.root}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.card}>
          <Pressable onPress={() => switchMode('register')} hitSlop={8}>
            <Text style={s.back}>← Назад</Text>
          </Pressable>
          <Text style={s.title}>Как вас представить?</Text>
          <Text style={s.lead}>
            Имя и фамилию увидят собеседники вместо @{nick}. Почта пригодится, чтобы восстановить
            доступ. Всё это можно указать и позже в профиле.
          </Text>
          <TextInput
            style={s.input}
            placeholder="Имя"
            placeholderTextColor="#555"
            value={firstName}
            onChangeText={setFirstName}
            maxLength={64}
            textContentType="givenName"
            autoFocus
          />
          <TextInput
            style={s.input}
            placeholder="Фамилия"
            placeholderTextColor="#555"
            value={lastName}
            onChangeText={setLastName}
            maxLength={64}
            textContentType="familyName"
          />
          <TextInput
            style={s.input}
            placeholder="Электронная почта"
            placeholderTextColor="#555"
            value={email}
            onChangeText={setEmail}
            maxLength={254}
            keyboardType="email-address"
            autoCapitalize="none"
            textContentType="emailAddress"
          />

          {error !== '' && <Text style={s.error}>{error}</Text>}

          <Pressable
            style={[s.submit, (loading || !hasAbout) && s.disabled]}
            onPress={() => void register(true)}
            disabled={loading || !hasAbout}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.submitText}>Готово</Text>
            )}
          </Pressable>
          <Pressable style={s.skip} onPress={() => void register(false)} disabled={loading}>
            <Text style={s.skipText}>Пропустить</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  const isLogin = mode === 'login';
  const disabled =
    loading ||
    !isCompleteRuPhone(phone) ||
    (!isLogin && (check.state !== 'ok' || password.length < 8 || phoneDiscoverable === null));

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={s.card}>
        <Image
          source={require('../assets/logo-mark.png')}
          style={s.logoMark}
          resizeMode="contain"
          accessible={false}
        />
        <Text style={s.logo}>Quazar</Text>

        <View style={s.tabs}>
          <Pressable
            style={[s.tab, isLogin && s.activeTab]}
            onPress={() => switchMode('login')}>
            <Text style={[s.tabText, isLogin && s.activeTabText]}>Войти</Text>
          </Pressable>
          <Pressable
            style={[s.tab, !isLogin && s.activeTab]}
            onPress={() => switchMode('register')}>
            <Text style={[s.tabText, !isLogin && s.activeTabText]}>Регистрация</Text>
          </Pressable>
        </View>

        <TextInput
          style={s.input}
          placeholder="+7 (999) 000-00-00"
          placeholderTextColor="#555"
          value={phone}
          onChangeText={text => setPhone(formatRuPhoneMask(text))}
          keyboardType="phone-pad"
        />
        {!isLogin && (
          <>
            <TextInput
              style={[s.input, s.nickInput]}
              placeholder="@никнейм"
              placeholderTextColor="#555"
              value={username}
              onChangeText={text => setUsername(text.replace(/\s/g, ''))}
              maxLength={USERNAME_MAX + 1}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="ascii-capable"
              textContentType="username"
            />
            <Text
              style={[
                s.hint,
                check.state === 'bad' && s.hintBad,
                check.state === 'ok' && s.hintOk,
              ]}>
              {check.state === 'bad'
                ? check.message
                : check.state === 'ok'
                  ? 'Никнейм свободен'
                  : check.state === 'checking'
                    ? 'Проверяем…'
                    : 'Латиницей: по нему вас найдут и @упомянут'}
            </Text>
          </>
        )}
        <TextInput
          style={s.input}
          placeholder="Пароль"
          placeholderTextColor="#555"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        {!isLogin && (
          <View style={s.choice}>
            <PhoneVisibilityChoice value={phoneDiscoverable} onChange={setPhoneDiscoverable} />
          </View>
        )}

        {error !== '' && <Text style={s.error}>{error}</Text>}

        <Pressable
          style={[s.submit, disabled && s.disabled]}
          onPress={() => (isLogin ? void login() : toAbout())}
          disabled={disabled}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.submitText}>{isLogin ? 'Войти' : 'Далее'}</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117', alignItems: 'center', justifyContent: 'center'},
  card: {width: '88%', maxWidth: 360},
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
});
