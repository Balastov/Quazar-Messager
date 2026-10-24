import { create } from "zustand";
import { usersApi } from "../api/users";
import { socket } from "../ws/socket";

interface WallpaperState {
  /** Личный фон приложения (/media/backgrounds/…) или null — стандартный. */
  personalUrl: string | null;
  load: () => Promise<void>;
  /** null — вернуть стандартный. */
  setPersonal: (file: Blob | null) => Promise<void>;
  reset: () => void;
}

export const useWallpaperStore = create<WallpaperState>((set) => {
  // Сменили на другом устройстве — меняем и здесь.
  socket.on((event) => {
    if (event.type === "user_background") set({ personalUrl: event.background_url });
  });

  return {
    personalUrl: null,

    load: async () => {
      try {
        set({ personalUrl: (await usersApi.background()).background_url });
      } catch {
        // Без личного фона — стандартный; не повод ломать вход.
      }
    },

    setPersonal: async (file) => {
      const res = file ? await usersApi.uploadBackground(file) : await usersApi.removeBackground();
      set({ personalUrl: res.background_url });
    },

    reset: () => set({ personalUrl: null }),
  };
});
