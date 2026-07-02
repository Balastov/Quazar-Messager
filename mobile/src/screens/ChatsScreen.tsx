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
import {usersApi} from '../api/users';
import type {RootStackParamList} from '../navigation';
import type {Chat, User} from '../api/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Chats'>;

export default function ChatsScreen({navigation}: Props) {
  const {chats, loadChats, openDirectChat} = useChatStore();
  const currentUser = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);

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
        <Pressable onPress={logout} style={{marginRight: 4}}>
          <Text style={{color: '#ff6b6b', fontSize: 14, fontWeight: '600'}}>Выйти</Text>
        </Pressable>
      ),
    });
  }, [navigation, logout]);

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
    const other = chat.members.find(m => m.user.id !== currentUser?.id);
    return other?.user.username ?? 'Неизвестный';
  };

  const openChat = (chat: Chat) => {
    navigation.navigate('Chat', {chatId: chat.id, title: chatName(chat)});
  };

  const startDirectChat = async (user: User) => {
    setSearch('');
    setResults([]);
    const chatId = await openDirectChat(user.id);
    navigation.navigate('Chat', {chatId, title: user.username});
  };

  return (
    <View style={s.root}>
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

      {search.length >= 2 && (
        <View style={s.dropdown}>
          {searching && <ActivityIndicator color="#6c63ff" style={{padding: 12}} />}
          {!searching && results.length === 0 && (
            <Text style={s.hint}>Никого не найдено</Text>
          )}
          {results.map(u => (
            <Pressable key={u.id} style={s.userRow} onPress={() => startDirectChat(u)}>
              <View style={s.avatar}>
                <Text style={s.avatarText}>{u.username[0].toUpperCase()}</Text>
              </View>
              <Text style={s.userName}>{u.username}</Text>
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
            </View>
            <Text style={s.chatName}>{chatName(item)}</Text>
          </Pressable>
        )}
        contentContainerStyle={{paddingTop: 4}}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
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
  chatName: {color: '#e0e0e0', fontSize: 15, fontWeight: '500'},
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
