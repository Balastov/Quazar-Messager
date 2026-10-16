import {create} from 'zustand';
import {BackupError} from '../crypto/backup';
import {
  createAndUploadBackup,
  restoreFromServerBackup,
  rotateKeys,
  syncIdentityWithServer,
} from '../crypto/keys';

/**
 * - ready: ключ устройства = ключ аккаунта, можно читать и отправлять.
 * - needs_restore: у аккаунта есть ключ с другого устройства — его нужно восстановить из копии.
 */
export type E2EStatus = 'idle' | 'checking' | 'ready' | 'needs_restore' | 'error';

interface E2EState {
  userId: string | null;
  status: E2EStatus;
  hasLocalKey: boolean;
  hasServerBackup: boolean;
  /** Экран восстановления ещё не показывали для текущего needs_restore. */
  restorePromptPending: boolean;
  busy: boolean;
  error: string | null;

  sync: (userId: string) => Promise<void>;
  restore: (password: string) => Promise<void>;
  createBackup: (password: string) => Promise<void>;
  rotate: (accountPassword: string) => Promise<void>;
  consumeRestorePrompt: () => void;
  reset: () => void;
}

const initialState = {
  userId: null,
  status: 'idle' as E2EStatus,
  hasLocalKey: false,
  hasServerBackup: false,
  restorePromptPending: false,
  busy: false,
  error: null,
};

export const useE2EStore = create<E2EState>((set, get) => {
  /** Выполняет действие с ключами; sync() на это время не вмешивается. */
  async function exclusive(fn: (userId: string) => Promise<void>): Promise<void> {
    const {userId} = get();
    if (!userId) {
      throw new BackupError('Сначала войдите в аккаунт');
    }
    set({busy: true});
    try {
      await fn(userId);
    } finally {
      set({busy: false});
      await get().sync(userId);
    }
  }

  return {
    ...initialState,

    sync: async userId => {
      if (get().busy) {return;}
      const prev = get();
      set({
        userId,
        status: prev.status === 'ready' && prev.userId === userId ? 'ready' : 'checking',
        error: null,
      });
      try {
        const res = await syncIdentityWithServer(userId);
        if (get().userId !== userId) {return;}
        if (res.status === 'ready') {
          set({
            status: 'ready',
            hasLocalKey: true,
            hasServerBackup: res.hasServerBackup,
            restorePromptPending: false,
          });
        } else {
          set({
            status: 'needs_restore',
            hasLocalKey: res.hasLocalKey,
            hasServerBackup: res.hasServerBackup,
            restorePromptPending:
              prev.status !== 'needs_restore' || prev.restorePromptPending,
          });
        }
      } catch (err) {
        console.error('e2e sync', err);
        set({status: 'error', error: 'Не удалось проверить ключи шифрования'});
      }
    },

    restore: password => exclusive(userId => restoreFromServerBackup(userId, password)),

    createBackup: password => exclusive(userId => createAndUploadBackup(userId, password)),

    rotate: accountPassword => exclusive(userId => rotateKeys(userId, accountPassword)),

    consumeRestorePrompt: () => set({restorePromptPending: false}),

    reset: () => set(initialState),
  };
});
