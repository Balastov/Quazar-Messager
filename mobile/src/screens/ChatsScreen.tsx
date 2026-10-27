import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useChatStore} from '../store/chat';
import {useAuthStore} from '../store/auth';
import {useE2EStore} from '../store/e2e';
import {usersApi} from '../api/users';
import type {RootStackParamList} from '../navigation';
import type {Chat, User} from '../api/types';
import {useContactsStore} from '../store/contacts';
import ContactsPrompt from '../contacts/ContactsPrompt';
import PresenceDot from '../components/PresenceDot';
import {displayName} from '../utils/profile';

type Props = NativeStackScreenProps<RootStackParamList, 'Chats'>;

export default function ChatsScreen({navigation}: Props) {
  const {chats, loadChats, openDirectChat} = useChatStore();
  const currentUser = useAuthStore(s => s.user);
  const contacts = useContactsStore(s => s.contacts);
  const e2eStatus = useE2EStore(s => s.status);
  const hasServerBackup = useE2EStore(s => s.hasServerBackup);
  const restorePromptPending = useE2EStore(s => s.restorePromptPending);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadChats();
    }, [loadChats]),
  );

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate('Profile')} hitSlop={8} style={{marginRight: 4}}>
          <Text style={{color: '#c4b5fd', fontSize: 14, fontWeight: '600'}}>Профиль</Text>
        </Pressable>
      ),
    });
  }, [navigation]);

  // Ключ аккаунта есть на другом устройстве — сразу предлагаем восстановить его здесь.
  useEffect(() => {
    if (e2eStatus === 'needs_restore' && restorePromptPending) {
      useE2EStore.getState().consumeRestorePrompt();
      navigation.navigate('Keys');
    }
  }, [e2eStatus, restorePromptPending, navigation]);

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await usersApi.search(search));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const chatName = (chat: Chat) => {
    if (chat.type === 'group') {return chat.name ?? 'Группа';}
    if (chat.type === 'saved') {return 'Записная книжка';}
    const other = chat.members.find(m => m.user.id !== currentUser?.id);
    // Как человек записан в телефонной книге — так и показываем.
    const fromPhonebook = contacts.find(c => c.user.id === other?.user.id)?.name;
    return fromPhonebook || displayName(other?.user) || 'Неизвестный';
  };

  // Контакты из книги, с которыми ещё нет чата, — в начале списка.
  const chatPeers = new Set(
    chats
      .filter(c => c.type === 'direct')
      .flatMap(c => c.members.map(m => m.user.id)),
  );
  const newContacts = contacts.filter(c => !chatPeers.has(c.user.id));
  const q = search.trim().toLowerCase();
  const contactMatches =
    q.length >= 2
      ? contacts.filter(
          c =>
            c.name.toLowerCase().includes(q) ||
            c.user.username.toLowerCase().includes(q) ||
            displayName(c.user).toLowerCase().includes(q),
        )
      : [];

  const openChat = (chat: Chat) => {
    navigation.navigate('Chat', {chatId: chat.id, title: chatName(chat)});
  };

  const startDirectChat = async (user: User, title = displayName(user)) => {
    setSearch('');
    setResults([]);
    const chatId = await openDirectChat(user.id);
    navigation.navigate('Chat', {chatId, title});
  };

  return (
    <View style={s.root}>
      {e2eStatus === 'needs_restore' && (
        <Pressable style={[s.banner, s.bannerWarn]} onPress={() => navigation.navigate('Keys')}>
          <Text style={s.bannerText}>
            Ключи шифрования не восстановлены — личные сообщения недоступны. Нажмите, чтобы
            восстановить.
          </Text>
        </Pressable>
      )}
      {e2eStatus === 'ready' && !hasServerBackup && (
        <Pressable style={s.banner} onPress={() => navigation.navigate('Keys')}>
          <Text style={s.bannerText}>
            Создайте резервную копию ключей — без неё переписка не откроется на других
            устройствах.
          </Text>
        </Pressable>
      )}
      <View style={s.searchWrap}>
        <TextInput
          style={s.search}
          placeholder="Найти пользователя..."
          placeholderTextColor="#555"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />
      </View>

      <ContactsPrompt />
      {search.length >= 2 && (
        <View style={s.dropdown}>
          {contactMatches.map(c => (
            <Pressable key={`c-${c.user.id}`} style={s.userRow} onPress={() => startDirectChat(c.user, c.name)}>
              <View style={s.avatar}>
                <Text style={s.avatarText}>{(c.name || displayName(c.user))[0].toUpperCase()}</Text>
                <PresenceDot userId={c.user.id} />
              </View>
              <View>
                <Text style={s.userName}>{c.name}</Text>
                <Text style={s.contactSub}>📇 из контактов · @{c.user.username}</Text>
              </View>
            </Pressable>
          ))}
          {searching && <ActivityIndicator color="#6c63ff" style={{padding: 12}} />}
          {!searching && results.length === 0 && contactMatches.length === 0 && (
            <Text style={s.hint}>Никого не найдено</Text>
          )}
          {results.filter(u => !contactMatches.some(c => c.user.id === u.id)).map(u => (
            <Pressable key={u.id} style={s.userRow} onPress={() => startDirectChat(u)}>
              <View style={s.avatar}>
                <Text style={s.avatarText}>{displayName(u)[0].toUpperCase()}</Text>
                <PresenceDot userId={u.id} />
              </View>
              <View>
                <Text style={s.userName}>{displayName(u)}</Text>
                <Text style={s.contactSub}>@{u.username}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      <FlatList
        data={chats}
        keyExtractor={item => item.id}
        renderItem={({item}) => (
          <Pressable style={s.chatItem} onPress={() => openChat(item)}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{chatName(item)[0].toUpperCase()}</Text>
              {item.type === 'direct' && (
                <PresenceDot userId={item.members.find(m => m.user.id !== currentUser?.id)?.user.id} />
              )}
            </View>
            <Text style={s.chatName}>
              {chatName(item)}
              {/* Официальный аккаунт Квазара — фирменная зелёная галочка. */}
              {item.type === 'support' && <Text style={s.official}> ✔</Text>}
            </Text>
          </Pressable>
        )}
        contentContainerStyle={{paddingTop: 4}}
        ListHeaderComponent={
          newContacts.length > 0 ? (
            <View>
              <Text style={s.sectionTitle}>Из телефонной книги</Text>
              {newContacts.map(c => (
                <Pressable key={c.user.id} style={s.chatItem} onPress={() => startDirectChat(c.user, c.name)}>
                  <View style={s.avatar}>
                    <Text style={s.avatarText}>{(c.name || displayName(c.user))[0].toUpperCase()}</Text>
                    <PresenceDot userId={c.user.id} />
                  </View>
                  <View>
                    <Text style={s.chatName}>{c.name}</Text>
                    <Text style={s.contactSub}>в Quazar · @{c.user.username}</Text>
                  </View>
                </Pressable>
              ))}
              {chats.length > 0 && <Text style={s.sectionTitle}>Чаты</Text>}
            </View>
          ) : null
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
  banner: {
    marginHorizontal: 12,
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#1a1d27',
    borderWidth: 1,
    borderColor: '#2a2d3a',
  },
  bannerWarn: {borderColor: 'rgba(251, 191, 36, 0.5)'},
  bannerText: {color: '#e0e0e0', fontSize: 13, lineHeight: 18},
  searchWrap: {padding: 12},
  search: {
    backgroundColor: '#1a1d27',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#e0e0e0',
    fontSize: 14,
  },
  dropdown: {
    marginHorizontal: 12,
    backgroundColor: '#1a1d27',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2d3a',
    marginBottom: 8,
    overflow: 'hidden',
  },
  hint: {color: '#888', padding: 12, fontSize: 13},
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  userName: {color: '#e0e0e0', fontSize: 14},
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1d27',
  },
  official: {color: '#34d399', fontWeight: '700'},
  chatName: {color: '#e0e0e0', fontSize: 15, fontWeight: '500'},
  contactSub: {color: '#9b93b8', fontSize: 12, marginTop: 2},
  sectionTitle: {
    color: '#6f678c',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {color: '#fff', fontWeight: '700', fontSize: 17},
});
