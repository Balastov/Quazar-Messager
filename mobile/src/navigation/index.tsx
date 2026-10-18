import React from 'react';
import {ActivityIndicator, View} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useAuthStore} from '../store/auth';
import AuthScreen from '../screens/AuthScreen';
import ChatsScreen from '../screens/ChatsScreen';
import ChatScreen from '../screens/ChatScreen';
import KeysScreen from '../screens/KeysScreen';
import ProfileScreen from '../screens/ProfileScreen';

export type RootStackParamList = {
  Auth: undefined;
  Chats: undefined;
  Chat: {chatId: string; title: string};
  Keys: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function Navigation() {
  const {token, hydrated} = useAuthStore();

  if (!hydrated) {
    return (
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f1117'}}>
        <ActivityIndicator color="#6c63ff" size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {backgroundColor: '#1a1d27'},
          headerTintColor: '#e0e0e0',
          headerTitleStyle: {fontWeight: '600'},
          contentStyle: {backgroundColor: '#0f1117'},
        }}>
        {!token ? (
          <Stack.Screen name="Auth" component={AuthScreen} options={{headerShown: false}} />
        ) : (
          <>
            <Stack.Screen
              name="Chats"
              component={ChatsScreen}
              options={{title: 'Quazar', headerLargeTitle: true}}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={({route}) => ({title: route.params.title})}
            />
            <Stack.Screen
              name="Keys"
              component={KeysScreen}
              options={{title: 'Ключи шифрования'}}
            />
            <Stack.Screen name="Profile" component={ProfileScreen} options={{title: 'Профиль'}} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
