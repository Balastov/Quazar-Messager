import { devicesApi } from "../api/devices";

let last: string | null = null;

/**
 * Сообщает серверу, есть ли на этом устройстве ключ переписки аккаунта. Так другие устройства
 * подскажут, где взять ключ. Сервер получает только публичный ключ — его и так видят собеседники.
 */
export function reportDeviceKey(userId: string, publicKey: string | null): void {
  const tag = `${userId}:${publicKey ?? ""}`;
  if (tag === last) return;
  last = tag;
  try {
    void devicesApi.reportKey(publicKey).catch(() => {
      if (last === tag) last = null;
    });
  } catch {
    last = null;
  }
}

/** После выхода новая сессия должна сообщить заново. */
export function resetDeviceKeyReport(): void {
  last = null;
}
