import { create } from "zustand";
import { persist } from "zustand/middleware";
import axios from "axios";
import { http, setAuthToken } from "../api/client";
import { usersApi } from "../api/users";
import { socket } from "../ws/socket";
import { ensurePushSubscription, dropPushSubscription } from "../notifications/push";
import {setNotificationUser} from "../notifications/delivery";
import { useE2EStore } from "./e2e";
import { useStarsStore } from "./stars";
import { useNotifyStore } from "../notifications/levels";
import { useAdminStore } from "./admin";
import { useVoiceStore } from "./voice";
import { useDoorsStore } from "./doors";
import { useWallpaperStore } from "./wallpaper";
import type { User } from "../api/types";
import { useUnreadStore } from "./unread";

interface AuthState {
  token: string | null;
  user: User | null;
  phonePromptPending: boolean;
  dismissPhonePrompt: () => void;
  setToken: (token: string, beforeSession?: (user: User) => Promise<void>) => Promise<void>;
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
  setNotificationUser(userId);
  socket.connect(token);
  void useE2EStore.getState().sync(userId);
  void ensurePushSubscription();
  void useWallpaperStore.getState().load();
}

function persistedToken(): string | null {
  try { return JSON.parse(localStorage.getItem("quazar-auth") ?? "null")?.state?.token ?? null; }
  catch { return null; }
}

async function loginLock<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks?.request ? navigator.locks.request("quazar-account-login", work) : work();
}
let authRevision = 0;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      phonePromptPending: false,
      dismissPhonePrompt: () => set({ phonePromptPending: false }),

      setToken: async (token, beforeSession) => {
        const initial = persistedToken();
        await loginLock(async () => {
          const revision = authRevision;
          if (persistedToken() !== initial) throw new Error("В другой вкладке изменился аккаунт. Обновите страницу");
          setAuthToken(token);
          try {
            const user = await usersApi.me();
            if (revision !== authRevision || persistedToken() !== initial) throw new Error("Вход отменён или аккаунт изменился");
            if (beforeSession) await beforeSession(user);
            if (revision !== authRevision || persistedToken() !== initial) throw new Error("Вход отменён или аккаунт изменился");
            setAuthToken(token);
            set({ token, user, phonePromptPending: !user.phone_verified_at });
            afterAuth(token, user.id);
          } catch (error) {
            if (http.defaults.headers.common["Authorization"] === `Bearer ${token}`) setAuthToken(get().token);
            throw error;
          }
        });
      },

      setUser: (user) => { if (get().token && get().user?.id === user.id) set({ user }); },
      refreshSession: async (token) => {
        authRevision++;
        if (!get().user) { await get().setToken(token); return; }
        setAuthToken(token);
        set({ token });
        socket.connect(token);
        const user = await usersApi.me();
        if (get().token === token) set({ user });
      },

      logout: () => {
        authRevision++;
        const token = get().token;
        if (token) void http.delete("/auth/devices/current", { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
        void dropPushSubscription();
        setNotificationUser(null);
        setAuthToken(null);
        socket.disconnect();
        void import("./call").then(({ useCallStore }) => useCallStore.getState().hangup()).catch(() => {});
        useE2EStore.getState().reset();
        void useVoiceStore.getState().leave();
        useDoorsStore.getState().reset();
        useStarsStore.getState().reset();
        useNotifyStore.getState().reset();
        useUnreadStore.getState().replace({});
        useAdminStore.getState().reset();
        useWallpaperStore.getState().reset();
        set({ token: null, user: null, phonePromptPending: false });
      },
    }),
    {
      name: "quazar-auth",
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          const token = state.token;
          setAuthToken(token);
          usersApi
            .me()
            .then((user) => {
              if (useAuthStore.getState().token !== token) return;
              useAuthStore.setState({ user });
              afterAuth(token, user.id);
            })
            .catch(() => {
              if (useAuthStore.getState().token === token) state.logout();
            });
        } else { setNotificationUser(null); void dropPushSubscription(); }
      },
    }
  )
);

let sessionCheck: ReturnType<typeof setTimeout> | undefined;
if (typeof window !== "undefined") {
  window.addEventListener("quazar-session-check", event => {
    const token = (event as CustomEvent<{ token: string }>).detail?.token;
    clearTimeout(sessionCheck);
    sessionCheck = setTimeout(() => {
      if (!token || useAuthStore.getState().token !== token) return;
      void usersApi.me().then(() => {
        if (useAuthStore.getState().token === token) socket.connect(token);
      }).catch(() => {});
    }, 5000);
  });
  window.addEventListener("storage", event => {
    if (event.key !== "quazar-auth") return;
    const token = useAuthStore.getState().token;
    if (token && persistedToken() !== token) window.location.reload();
  });
}
