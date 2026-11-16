/**
 * Карточка профиля человека: открывается по нажатию на аватар, имя или псевдоним
 * в чатах и Звёздах. Одна на всё приложение — рисует её MessengerPage.
 */
import { create } from "zustand";

/** Что уже известно о человеке там, где нажали, — карточка покажет это сразу, до ответа сервера. */
export interface ProfileHint {
  username?: string;
  display_name?: string | null;
  avatar_url?: string | null;
  is_premium?: boolean;
}

export interface ProfileTarget {
  userId: string;
  /** Открыли из Звезды — покажем псевдоним в ней. */
  starId?: string | null;
  hint?: ProfileHint;
}

interface ProfileState {
  target: ProfileTarget | null;
  open: (target: ProfileTarget) => void;
  close: () => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
