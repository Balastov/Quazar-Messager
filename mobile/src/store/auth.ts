import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import {setAuthToken} from '../api/client';
import {usersApi} from '../api/users';
import {socket} from '../ws/socket';
import {loadOrCreateKeys, uploadPublicKey} from '../crypto/keys';
import type {User} from '../api/types';

interface AuthState {
  token: string | null;
  user: User | null;
  hydrated: boolean;
  setToken: (token: string) => Promise<void>;
  logout: () => void;
}

async function initE2EKeys() {
  const {publicKey} = await loadOrCreateKeys();
  await uploadPublicKey(publicKey);
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      hydrated: false,

      setToken: async (token: string) => {
        setAuthToken(token);
        const user = await usersApi.me();
        set({token, user});
        socket.connect(token);
        initE2EKeys().catch(console.error);
      },

      logout: () => {
        setAuthToken(null);
        socket.disconnect();
        set({token: null, user: null});
      },
    }),
    {
      name: 'quazar-auth',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          setAuthToken(state.token);
          usersApi
            .me()
            .then(user => {
              useAuthStore.setState({user, hydrated: true});
              socket.connect(state.token!);
              initE2EKeys().catch(console.error);
            })
            .catch(() => {
              state.logout();
              useAuthStore.setState({hydrated: true});
            });
        } else {
          useAuthStore.setState({hydrated: true});
        }
      },
    },
  ),
);
