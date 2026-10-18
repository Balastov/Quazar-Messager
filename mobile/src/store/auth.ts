import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import {setAuthToken} from '../api/client';
import {usersApi} from '../api/users';
import {socket} from '../ws/socket';
import {useE2EStore} from './e2e';
import {useContactsStore} from './contacts';
import type {User} from '../api/types';

interface AuthState {
  token: string | null;
  user: User | null;
  hydrated: boolean;
  setToken: (token: string) => Promise<void>;
  logout: () => void;
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
        void useE2EStore.getState().sync(user.id);
      },

      logout: () => {
        setAuthToken(null);
        socket.disconnect();
        useE2EStore.getState().reset();
        useContactsStore.getState().reset();
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
              void useE2EStore.getState().sync(user.id);
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
