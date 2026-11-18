/**
 * Сверка числом при передаче ключей переписки между своими устройствами.
 *
 * Новое устройство показывает двузначное число, на старом нужно нажать такое же из трёх.
 * Чтобы сервер (или тот, кто его взломал) не мог подобрать подменные ключи под совпадающее число,
 * число складывается из двух случайных половин, и каждую сторона выбирает, не зная чужой:
 *  1. новое устройство заранее отправляет только хэш своего случайного числа (commitment);
 *  2. старое, увидев хэш, отправляет своё число открыто;
 *  3. новое раскрывает своё, старое сверяет его с хэшем.
 * Подмена ключа даёт другое число на одном из экранов — совпадение случайно, 1 из 90.
 */
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import type { PairView } from "../api/devices";
import { pairBinding } from "./deviceTransfer";

const enc = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function randomNonce(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function validNonce(value: string | null | undefined): value is string {
  try {
    return !!value && decodeBase64(value).length === 32;
  } catch {
    return false;
  }
}

/** Хэш, которым новое устройство фиксирует своё число (так же считает сервер). */
export async function commitNonce(receiverPublicKey: string, nonce: string): Promise<string> {
  return hex(await sha256(`quazar-keys-commit-v1:${receiverPublicKey}:${nonce}`));
}

/** Раскрытое число нового устройства совпадает с хэшем, который оно прислало заранее. */
export async function commitmentMatches(flow: PairView): Promise<boolean> {
  if (!flow.commitment || !flow.receiver_public_key || !validNonce(flow.receiver_nonce)) return false;
  return (await commitNonce(flow.receiver_public_key, flow.receiver_nonce)) === flow.commitment;
}

/** Число для сверки: от 10 до 99, одинаковое на обоих экранах, только если ключи не подменены. */
export async function keyNumber(flow: PairView): Promise<number> {
  if (!validNonce(flow.receiver_nonce) || !validNonce(flow.approver_nonce)) throw new Error("Число ещё не готово");
  const binding = await pairBinding(flow);
  const digest = await sha256(JSON.stringify(["quazar-keys-number-v1", binding, flow.receiver_nonce, flow.approver_nonce]));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return 10 + (value % 90);
}

/** Три разных числа вперемешку, одно из них — верное. */
export function numberChoices(correct: number, random: () => number = Math.random): number[] {
  const choices = new Set([correct]);
  while (choices.size < 3) choices.add(10 + Math.floor(random() * 90));
  const list = [...choices];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
