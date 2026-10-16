import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Node 25 подсовывает свой неполноценный localStorage вместо happy-dom.
const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
});

const ACCOUNT_PASSWORD = "account-password";
const USER_ID = "user-1";

/** Сервер в памяти: только то, что нужно ключам E2E. */
const server = {
  publicKey: null as string | null,
  backup: null as string | null,
};

function httpError(status: number, detail: string) {
  return Object.assign(new Error(detail), {
    isAxiosError: true,
    response: { status, data: { detail } },
  });
}

vi.mock("../../api/client", () => ({
  http: {
    get: async (url: string) => {
      if (url === `/users/${USER_ID}/key`) {
        return { data: { user_id: USER_ID, public_key: server.publicKey } };
      }
      if (url === "/users/me/key-backup") return { data: { backup: server.backup } };
      throw httpError(404, "Not found");
    },
    put: async (url: string, body: { public_key?: string; backup?: string }) => {
      if (url === "/users/me/key") {
        if (server.publicKey && server.publicKey !== body.public_key) {
          throw httpError(409, "Public key already set. Use force=true to rotate.");
        }
        server.publicKey = body.public_key!;
        return { data: {} };
      }
      if (url === "/users/me/key-backup") {
        server.backup = body.backup!;
        return { data: {} };
      }
      throw httpError(404, "Not found");
    },
    post: async (url: string, body: { password: string; public_key: string }) => {
      if (url === "/users/me/key/rotate") {
        if (body.password !== ACCOUNT_PASSWORD) throw httpError(401, "Invalid password");
        server.publicKey = body.public_key;
        server.backup = null;
        return { data: {} };
      }
      throw httpError(404, "Not found");
    },
  },
}));

const { useE2EStore } = await import("../e2e");
const { loadDecryptionKeys, loadKeys, StaleBackupError } = await import("../../crypto/keys");

/** Новое «устройство»: пустая IndexedDB и localStorage, свежий стор. */
function switchDevice() {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  useE2EStore.getState().reset();
}

async function syncDevice() {
  await useE2EStore.getState().sync(USER_ID);
  return useE2EStore.getState().status;
}

beforeEach(() => {
  server.publicKey = null;
  server.backup = null;
  switchDevice();
});

describe("account key across devices", () => {
  it("restores the account key on a second device", async () => {
    // Ноутбук: первое устройство, создаёт ключ аккаунта и копию.
    expect(await syncDevice()).toBe("ready");
    const laptopKey = (await loadKeys())!.publicKey;
    expect(server.publicKey).toBe(laptopKey);
    await useE2EStore.getState().createBackup("backup-password");
    expect(server.backup).not.toBeNull();

    // Телефон: ключ аккаунта уже есть — свой не создаёт и серверный не трогает.
    switchDevice();
    expect(await syncDevice()).toBe("needs_restore");
    expect(server.publicKey).toBe(laptopKey);

    await useE2EStore.getState().restoreFromServer("backup-password");
    expect(useE2EStore.getState().status).toBe("ready");
    expect((await loadKeys())!.publicKey).toBe(laptopKey);
  });

  it("keeps the previous device key for old history", async () => {
    await syncDevice();
    await useE2EStore.getState().createBackup("backup-password");
    const accountKey = server.publicKey;

    // Телефон со своим старым ключом.
    switchDevice();
    const own = nacl.box.keyPair();
    const { saveIdentitySeed } = await import("../../crypto/webcrypto");
    await saveIdentitySeed(own.secretKey);

    expect(await syncDevice()).toBe("needs_restore");
    await useE2EStore.getState().restoreFromServer("backup-password");

    expect((await loadKeys())!.publicKey).toBe(accountKey);
    const keys = await loadDecryptionKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1].seed).toEqual(own.secretKey);
  });

  it("offers to adopt a backup whose key was overwritten on the server", async () => {
    await syncDevice();
    await useE2EStore.getState().createBackup("backup-password");
    const laptopKey = server.publicKey;
    const blob = server.backup!;

    // Старая версия клиента на другом устройстве перезаписала ключ на сервере.
    server.publicKey = encodeBase64(nacl.box.keyPair().publicKey);
    expect(await syncDevice()).toBe("needs_restore");
    expect(useE2EStore.getState().restorePromptOpen).toBe(true);

    const err = await useE2EStore
      .getState()
      .restoreFromServer("backup-password")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleBackupError);
    // Окно не должно закрываться во время повторной проверки.
    expect(useE2EStore.getState().status).toBe("needs_restore");
    expect(useE2EStore.getState().restorePromptOpen).toBe(true);

    // Неверный пароль аккаунта ничего не меняет.
    await expect(
      useE2EStore.getState().adoptBackup(blob, "backup-password", "wrong-password")
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(useE2EStore.getState().status).toBe("needs_restore");

    await useE2EStore.getState().adoptBackup(blob, "backup-password", ACCOUNT_PASSWORD);
    expect(useE2EStore.getState().status).toBe("ready");
    expect(server.publicKey).toBe(laptopKey);
    expect(server.backup).toBe(blob);
    expect((await loadKeys())!.publicKey).toBe(laptopKey);
  });

  it("does not persist a rotated key the server rejected", async () => {
    await syncDevice();
    const before = (await loadKeys())!.publicKey;
    await expect(useE2EStore.getState().rotate("wrong-password")).rejects.toBeTruthy();
    expect((await loadKeys())!.publicKey).toBe(before);
    expect(useE2EStore.getState().status).toBe("ready");
  });
});
