import { forgetDrafts } from "../chat/drafts";
import { clearAllTrustedKeys } from "../crypto/trust";
import { forgetAccountKeys } from "../crypto/webcrypto";
import { useAuthStore } from "../store/auth";

/**
 * Выход с чужого или общего компьютера: кроме сеанса, стираем ключи переписки аккаунта,
 * его черновики и список проверенных ключей собеседников. Если стереть не удалось — не выходим,
 * чтобы человек не ушёл, думая, что ключей здесь больше нет.
 */
export async function logoutAndForgetDevice(userId: string): Promise<void> {
  await forgetAccountKeys(userId);
  await forgetDrafts(userId);
  clearAllTrustedKeys();
  useAuthStore.getState().logout();
}
