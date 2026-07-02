import React, {useEffect, useRef, useState} from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useChatStore} from '../store/chat';
import {useAuthStore} from '../store/auth';
import type {RootStackParamList} from '../navigation';
import type {Message} from '../api/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({route}: Props) {
  const {chatId} = route.params;
  const {messages, loadingMessages, selectChat, sendMessage} = useChatStore();
  const currentUser = useAuthStore(s => s.user);
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<Message>>(null);

  const msgs = messages[chatId] ?? [];

  useEffect(() => {
    selectChat(chatId);
  }, [chatId, selectChat]);

  useEffect(() => {
    if (msgs.length > 0) {
      listRef.current?.scrollToEnd({animated: true});
    }
  }, [msgs.length]);

  const handleSend = async () => {
    const payload = text.trim();
    if (!payload) {return;}
    setText('');
    await sendMessage(chatId, payload);
  };

  const statusIcon = (status: string) => {
    if (status === 'read') {return '✓✓';}
    if (status === 'delivered') {return '✓✓';}
    return '✓';
  };

  const renderItem = ({item}: {item: Message}) => {
    const isOwn = item.sender_id === currentUser?.id;
    return (
      <View style={[s.bubble, isOwn ? s.own : s.other]}>
        <Text style={s.text}>{item.payload}</Text>
        <View style={s.meta}>
          <Text style={s.time}>
            {new Date(item.created_at).toLocaleTimeString('ru', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          {isOwn && <Text style={s.status}>{statusIcon(item.status)}</Text>}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      {loadingMessages ? (
        <ActivityIndicator style={{flex: 1}} color="#6c63ff" />
      ) : (
        <FlatList
          ref={listRef}
          data={msgs}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({animated: false})}
        />
      )}

      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          placeholder="Написать сообщение..."
          placeholderTextColor="#555"
          value={text}
          onChangeText={setText}
          multiline
        />
        <Pressable
          style={[s.sendBtn, !text.trim() && s.disabled]}
          onPress={handleSend}
          disabled={!text.trim()}>
          <Text style={s.sendIcon}>➤</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1117'},
  list: {paddingHorizontal: 12, paddingVertical: 8, gap: 6},
  bubble: {
    maxWidth: '72%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  own: {
    alignSelf: 'flex-end',
    backgroundColor: '#6c63ff',
    borderBottomRightRadius: 4,
  },
  other: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a1d27',
    borderBottomLeftRadius: 4,
  },
  text: {color: '#fff', fontSize: 14, lineHeight: 20},
  meta: {flexDirection: 'row', gap: 4, alignSelf: 'flex-end', marginTop: 2},
  time: {color: 'rgba(255,255,255,0.6)', fontSize: 11},
  status: {color: '#b0e0ff', fontSize: 11},
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    gap: 8,
    backgroundColor: '#1a1d27',
    borderTopWidth: 1,
    borderTopColor: '#2a2d3a',
  },
  input: {
    flex: 1,
    backgroundColor: '#0f1117',
    borderWidth: 1,
    borderColor: '#2a2d3a',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    color: '#e0e0e0',
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {opacity: 0.4},
  sendIcon: {color: '#fff', fontSize: 18},
});
