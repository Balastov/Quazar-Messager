import { create } from "zustand";
import { persist } from "zustand/middleware";
import axios from "axios";
import { http, setAuthToken } from "../api/client";
import { usersApi } from "../api/users";
import { socket } from "../ws/socket";
import { ensurePushSubscription } from "../notifications/push";
import { useE2EStore } from "./e2e";
import { useStarsStore } from "./stars";
import { useNotifyStore } from "../notifications/levels";
import { useAdminStore } from "./admin";
import { useVoiceStore } from "./voice";
import { useDoorsStore } from "./doors";
import { useWallpaperStore } from "./wallpaper";
import type { User } from "../api/types";

interface AuthState {
  token: string | null;
  user: User | null;
  phonePromptPending: boolean;
  dismissPhonePrompt: () => void;
  setToken: (token: string) => Promise<void>;
  setUser: (user: User) => void;
  refreshSession: (token: string) => Promise<void>;
  logout: () => void;
}

// Сервер перестал принимать сессию (заблокировали аккаунт, токен устарел) — выходим,
// а не оставляем экран с неработающими запросами.
http.interceptors.response.use(undefined, (err) => {
  const sentToken = axios.isAxiosError(err) && !!err.config?.headers?.Authorization;
  if (sentToken && axios.isAxiosError(err) && err.response?.status === 401 && useAuthStore.getState().token &&
      err.config?.headers?.Authorization === http.defaults.headers.common["Authorization"]) {
    useAuthStore.getState().logout();
  }
  return Promise.reject(err);
});

function afterAuth(token: string, userId: string) {
  socket.connect(token);
  void useE2EStore.getState().sync(userId);
  void ensurePushSubscription();
  void useWallpaperStore.getState().load();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      phonePromptPending: false,
      dismissPhonePrompt: () => set({ phonePromptPending: false }),

      setToken: async (token) => {
        setAuthToken(token);
        const user = await usersApi.me();
        setAuthToken(token);
        set({ token, user, phonePromptPending: !user.phone_verified_at });
        afterAuth(token, user.id);
      },

      setUser: (user) => set({ user }),
      refreshSession: async (token) => {
        if (!get().user) { await get().setToken(token); return; }
        setAuthToken(token);
        set({ token });
        socket.connect(token);
        const user = await usersApi.me();
        if (get().token === token) set({ user });
      },

      logout: () => {
        setAuthToken(null);
        socket.disconnect();
        useE2EStore.getState().reset();
        void useVoiceStore.getState().leave();
        useDoorsStore.getState().reset();
        useStarsStore.getState().reset();
        useNotifyStore.getState().reset();
        useAdminStore.getState().reset();
        useWallpaperStore.getState().reset();
        set({ token: null, user: null, phonePromptPending: false });
      },
    }),
    {
      name: "quazar-auth",
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          setAuthToken(state.token);
          usersApi
            .me()
            .then((user) => {
              useAuthStore.setState({ user });
              afterAuth(state.token!, user.id);
            })
            .catch(() => {
              state.logout();
            });
        }
      },
    }
  )
);
