import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setAuthToken } from "../api/client";
import { usersApi } from "../api/users";
import { socket } from "../ws/socket";
import { ensurePushSubscription } from "../notifications/push";
import { useE2EStore } from "./e2e";
import { useStarsStore } from "./stars";
import { useVoiceStore } from "./voice";
import { useDoorsStore } from "./doors";
import type { User } from "../api/types";

interface AuthState {
  token: string | null;
  user: User | null;
  setToken: (token: string) => Promise<void>;
  setUser: (user: User) => void;
  logout: () => void;
}

function afterAuth(token: string, userId: string) {
  socket.connect(token);
  void useE2EStore.getState().sync(userId);
  void ensurePushSubscription();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,

      setToken: async (token) => {
        setAuthToken(token);
        const user = await usersApi.me();
        set({ token, user });
        afterAuth(token, user.id);
      },

      setUser: (user) => set({ user }),

      logout: () => {
        setAuthToken(null);
        socket.disconnect();
        useE2EStore.getState().reset();
        void useVoiceStore.getState().leave();
        useDoorsStore.getState().reset();
        useStarsStore.getState().reset();
        set({ token: null, user: null });
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
