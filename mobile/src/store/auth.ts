import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import axios from 'axios';
import {http, setAuthToken} from '../api/client';
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
  setUser: (user: User) => void;
  refreshSession: (token: string) => Promise<void>;
  logout: () => void;
}

http.interceptors.response.use(undefined, err => {
  if (axios.isAxiosError(err) && err.response?.status === 401 && useAuthStore.getState().token &&
      err.config?.headers?.Authorization === http.defaults.headers.common.Authorization) {
    useAuthStore.getState().logout();
  }
  return Promise.reject(err);
});

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      hydrated: false,

      setToken: async (token: string) => {
        setAuthToken(token);
        const user = await usersApi.me();
        setAuthToken(token);
        set({token, user});
        socket.connect(token);
        void useE2EStore.getState().sync(user.id);
      },

      setUser: (user: User) => set({user}),
      refreshSession: async (token: string) => {
        if (!get().user) { await get().setToken(token); return; }
        setAuthToken(token);
        set(state => ({token, user: state.user ? {...state.user, has_password: true} : null}));
        socket.connect(token);
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
