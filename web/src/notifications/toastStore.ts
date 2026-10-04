import { create } from "zustand";

export interface AppToast {
  id: string;
  title: string;
  body: string;
  chatId?: string;
}

interface ToastState {
  toasts: AppToast[];
  push: (toast: Omit<AppToast, "id">) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (toast) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...toast, id }] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5200);
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
