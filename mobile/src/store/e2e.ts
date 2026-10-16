import {create} from 'zustand';
import {BackupError} from '../crypto/backup';
import {
  adoptServerBackupAsAccountKey,
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
  accountPublicKey: string | null;
  localPublicKey: string | null;
  /** Экран восстановления ещё не показывали для текущего needs_restore. */
  restorePromptPending: boolean;
  busy: boolean;
  error: string | null;

  sync: (userId: string) => Promise<void>;
  restore: (password: string) => Promise<void>;
  createBackup: (password: string) => Promise<void>;
  rotate: (accountPassword: string) => Promise<void>;
  adoptBackup: (backupPassword: string, accountPassword: string) => Promise<void>;
  consumeRestorePrompt: () => void;
  reset: () => void;
}

const initialState = {
  userId: null,
  status: 'idle' as E2EStatus,
  hasLocalKey: false,
  hasServerBackup: false,
  accountPublicKey: null,
  localPublicKey: null,
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
      const settled = prev.status === 'ready' || prev.status === 'needs_restore';
      set({
        userId,
        // Повторная проверка не должна «мигать»: держим прежнее состояние до ответа.
        status: settled && prev.userId === userId ? prev.status : 'checking',
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
            accountPublicKey: res.publicKey,
            localPublicKey: res.publicKey,
            restorePromptPending: false,
          });
        } else {
          set({
            status: 'needs_restore',
            hasLocalKey: res.hasLocalKey,
            hasServerBackup: res.hasServerBackup,
            accountPublicKey: res.accountPublicKey,
            localPublicKey: res.localPublicKey,
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

    adoptBackup: (backupPassword, accountPassword) =>
      exclusive(userId =>
        adoptServerBackupAsAccountKey(userId, backupPassword, accountPassword),
      ),

    consumeRestorePrompt: () => set({restorePromptPending: false}),

    reset: () => set(initialState),
  };
});
