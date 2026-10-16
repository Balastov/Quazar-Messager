import { create } from "zustand";
import { BackupError, readBackupFile } from "../crypto/backup";
import {
  createAndUploadBackup,
  fetchKeyBackup,
  restoreFromBackup,
  rotateKeys,
  syncIdentityWithServer,
} from "../crypto/keys";
import { logError } from "../utils/log";

/**
 * - ready: ключ устройства = ключ аккаунта, можно читать и отправлять.
 * - needs_restore: у аккаунта есть ключ с другого устройства — его нужно восстановить из копии.
 */
export type E2EStatus = "idle" | "checking" | "ready" | "needs_restore" | "error";

interface E2EState {
  userId: string | null;
  status: E2EStatus;
  hasLocalKey: boolean;
  hasServerBackup: boolean;
  restorePromptOpen: boolean;
  busy: boolean;
  error: string | null;

  sync: (userId: string) => Promise<void>;
  restoreFromServer: (password: string) => Promise<void>;
  restoreFromFile: (file: File, password: string) => Promise<void>;
  createBackup: (password: string) => Promise<string>;
  rotate: (accountPassword: string) => Promise<void>;
  setRestorePromptOpen: (open: boolean) => void;
  reset: () => void;
}

const initialState = {
  userId: null,
  status: "idle" as E2EStatus,
  hasLocalKey: false,
  hasServerBackup: false,
  restorePromptOpen: false,
  busy: false,
  error: null,
};

export const useE2EStore = create<E2EState>((set, get) => {
  function requireUserId(): string {
    const { userId } = get();
    if (!userId) throw new BackupError("Сначала войдите в аккаунт");
    return userId;
  }

  /** Выполняет действие с ключами; sync() на это время не вмешивается. */
  async function exclusive<T>(fn: (userId: string) => Promise<T>): Promise<T> {
    const userId = requireUserId();
    set({ busy: true });
    try {
      return await fn(userId);
    } finally {
      set({ busy: false });
      await get().sync(userId);
    }
  }

  return {
    ...initialState,

    sync: async (userId) => {
      if (get().busy) return;
      const prev = get();
      set({
        userId,
        // Повторная проверка не должна «мигать» уже рабочим состоянием.
        status: prev.status === "ready" && prev.userId === userId ? "ready" : "checking",
        error: null,
      });
      try {
        const res = await syncIdentityWithServer(userId);
        if (get().userId !== userId) return;
        if (res.status === "ready") {
          set({
            status: "ready",
            hasLocalKey: true,
            hasServerBackup: res.hasServerBackup,
            restorePromptOpen: false,
          });
        } else {
          set({
            status: "needs_restore",
            hasLocalKey: res.hasLocalKey,
            hasServerBackup: res.hasServerBackup,
            restorePromptOpen: prev.status !== "needs_restore" || prev.restorePromptOpen,
          });
        }
      } catch (err) {
        logError("e2e sync", err);
        set({ status: "error", error: "Не удалось проверить ключи шифрования" });
      }
    },

    restoreFromServer: (password) =>
      exclusive(async (userId) => {
        const blob = await fetchKeyBackup();
        if (!blob) throw new BackupError("На сервере нет резервной копии");
        await restoreFromBackup(userId, blob, password);
      }),

    restoreFromFile: (file, password) =>
      exclusive(async (userId) => {
        const blob = await readBackupFile(file);
        await restoreFromBackup(userId, blob, password);
      }),

    createBackup: (password) =>
      exclusive((userId) => createAndUploadBackup(userId, password)),

    rotate: (accountPassword) =>
      exclusive(async (userId) => {
        await rotateKeys(userId, accountPassword);
      }),

    setRestorePromptOpen: (open) => set({ restorePromptOpen: open }),

    reset: () => set(initialState),
  };
});
