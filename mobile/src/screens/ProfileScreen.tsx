import React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation';
import {useAuthStore} from '../store/auth';
import {useContactsStore} from '../store/contacts';
import {setMyManualStatus, useMyManualStatus} from '../store/presence';
import {MANUAL_LABEL, untilText, type ManualKind} from '../utils/presence';
import {displayName} from '../utils/profile';
import ProfileEditor from '../components/ProfileEditor';
import PhoneVisibilitySetting from '../components/PhoneVisibilitySetting';

const DURATIONS: {label: string; until: () => Date | null}[] = [
  {label: '30 мин', until: () => new Date(Date.now() + 30 * 60_000)},
  {label: '1 час', until: () => new Date(Date.now() + 60 * 60_000)},
  {label: '2 часа', until: () => new Date(Date.now() + 120 * 60_000)},
  {
    label: 'До конца дня',
    until: () => {
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      return d;
    },
  },
  {label: 'Пока не сниму', until: () => null},
];

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) {
    return one;
  }
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) {
    return few;
  }
  return many;
}

export default function ProfileScreen({navigation}: Props) {
  const user = useAuthStore(st => st.user);
  const logout = useAuthStore(st => st.logout);
  const {pref, contacts, total, lastSyncAt, syncing, error, blocked, enable, disable, syncNow} =
    useContactsStore();
  const on = pref === 'on';
  const manual = useMyManualStatus();
  const [statusKind, setStatusKind] = React.useState<ManualKind | null>(null);

  const toggle = (value: boolean) => {
    if (value) {
      void enable();
    } else {
      void disable();
    }
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <View style={s.card}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{displayName(user)?.[0]?.toUpperCase() ?? '?'}</Text>
        </View>
        <Text style={s.name}>{displayName(user)}</Text>
        <Text style={[s.muted, s.center]}>
          @{user?.username} · {user?.phone}
          {user?.phone_discoverable === false ? ' · скрыт' : ''}
        </Text>
      </View>

      {user && (
        <View style={s.card}>
          <Text style={s.title}>Профиль</Text>
          <ProfileEditor user={user} />
        </View>
      )}

      {user && (
        <View style={s.card}>
          <PhoneVisibilitySetting user={user} />
        </View>
      )}

      <View style={s.card}>
        <Text style={s.title}>Статус</Text>
        {manual ? (
          <View style={s.row}>
            <Text style={[s.muted, {flex: 1}]}>
              {manual.kind === 'dnd' ? '⛔' : '📅'} Сейчас: {MANUAL_LABEL[manual.kind]}
              {manual.until ? ` ${untilText(manual.until)}` : ''}
            </Text>
            <Pressable onPress={() => void setMyManualStatus(null, null)} hitSlop={6}>
              <Text style={s.link}>Снять</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={s.muted}>
            Покажет собеседникам, что вы заняты, — например, пока вы в Zoom или Телемосте.
          </Text>
        )}
        <View style={s.chips}>
          {(['meeting', 'dnd'] as ManualKind[]).map(kind => (
            <Pressable
              key={kind}
              style={[s.chip, statusKind === kind && s.chipActive]}
              onPress={() => setStatusKind(statusKind === kind ? null : kind)}>
              <Text style={s.chipText}>
                {kind === 'dnd' ? '⛔ Не беспокоить' : '📅 На встрече'}
              </Text>
            </Pressable>
          ))}
        </View>
        {statusKind && (
          <View style={s.chips}>
            {DURATIONS.map(d => (
              <Pressable
                key={d.label}
                style={s.chip}
                onPress={() => {
                  const kind = statusKind;
                  setStatusKind(null);
                  void setMyManualStatus(kind, d.until());
                }}>
                <Text style={s.chipText}>{d.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <View style={s.card}>
        <View style={s.row}>
          <View style={{flex: 1}}>
            <Text style={s.title}>Контакты из телефонной книги</Text>
            <Text style={s.muted}>
              Показывать, кто из ваших контактов уже в Quazar. Список обновляется сам при
              открытии приложения.
            </Text>
          </View>
          <Switch value={on} onValueChange={toggle} disabled={syncing} />
        </View>

        {on && (
          <View style={s.status}>
            {syncing ? (
              <ActivityIndicator color="#6c63ff" />
            ) : (
              <Text style={s.muted}>
                {`Нашли ${contacts.length} ${plural(contacts.length, 'человека', 'человек', 'человек')}` +
                  (total ? ` из ${total} ${plural(total, 'контакта', 'контактов', 'контактов')}` : '') +
                  (lastSyncAt ? ` · обновлено ${new Date(lastSyncAt).toLocaleString('ru')}` : '')}
              </Text>
            )}
            <Pressable onPress={() => void syncNow()} disabled={syncing} hitSlop={6}>
              <Text style={s.link}>Обновить сейчас</Text>
            </Pressable>
          </View>
        )}
        {blocked && (
          <View style={s.status}>
            <Text style={s.warn}>
              Доступ к контактам выключен в настройках телефона. Разрешите его там — и включите
              переключатель снова.
            </Text>
            <Pressable onPress={() => void Linking.openSettings()} hitSlop={6}>
              <Text style={s.link}>Открыть настройки</Text>
            </Pressable>
          </View>
        )}
        {error && <Text style={s.warn}>{error}</Text>}
        <Text style={s.note}>
          Номера сверяются на сервере и не сохраняются. Хранятся только найденные пользователи
          Quazar и имена, под которыми они записаны у вас. Выключите — и они удалятся с сервера.
        </Text>
      </View>

      <Pressable style={s.card} onPress={() => navigation.navigate('Keys')}>
        <Text style={s.title}>Ключи шифрования</Text>
        <Text style={s.muted}>Резервная копия и восстановление на другом устройстве</Text>
      </Pressable>

      <Pressable style={[s.card, s.logout]} onPress={logout}>
        <Text style={s.logoutText}>Выйти</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
  content: {padding: 14, gap: 12},
  card: {
    backgroundColor: '#1a1d27',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2a2d3a',
    padding: 16,
    gap: 8,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  avatarText: {color: '#fff', fontSize: 26, fontWeight: '700'},
  name: {color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  title: {color: '#fff', fontSize: 15, fontWeight: '600'},
  muted: {color: '#9b93b8', fontSize: 13, lineHeight: 18},
  center: {textAlign: 'center'},
  status: {gap: 6},
  link: {color: '#c4b5fd', fontSize: 14, fontWeight: '600'},
  warn: {color: '#fbbf24', fontSize: 13, lineHeight: 18},
  note: {color: '#6f678c', fontSize: 12, lineHeight: 16},
  logout: {alignItems: 'center'},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2a2d3a',
  },
  chipActive: {backgroundColor: 'rgba(108,99,255,0.25)', borderColor: '#6c63ff'},
  chipText: {color: '#e0e0e0', fontSize: 13},
  logoutText: {color: '#ff6b6b', fontSize: 15, fontWeight: '600'},
});
