import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setAuthToken } from "../api/client";
import { usersApi } from "../api/users";
import { socket } from "../ws/socket";
import { loadOrCreateKeys, markMigrationForUi, uploadPublicKey } from "../crypto/keys";
import type { User } from "../api/types";

interface AuthState {
  token: string | null;
  user: User | null;
  setToken: (token: string) => Promise<void>;
  logout: () => void;
}

async function initE2EKeys() {
  const { publicKey, migrated } = await loadOrCreateKeys();
  await uploadPublicKey(publicKey, migrated);
  if (migrated) {
    markMigrationForUi();
  }
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
        socket.connect(token);
        initE2EKeys().catch(console.error);
      },

      logout: () => {
        setAuthToken(null);
        socket.disconnect();
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
              socket.connect(state.token!);
              initE2EKeys().catch(console.error);
            })
            .catch(() => {
              state.logout();
            });
        }
      },
    }
  )
);
