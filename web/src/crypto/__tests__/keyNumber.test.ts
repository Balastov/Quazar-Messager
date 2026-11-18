import { describe, expect, it } from "vitest";
import type { PairView } from "../../api/devices";
import { pairKeys } from "../deviceTransfer";
import { commitmentMatches, commitNonce, keyNumber, numberChoices, randomNonce } from "../keyNumber";

async function flow(): Promise<PairView> {
  const receiver = pairKeys().publicKey, approver = pairKeys().publicKey, receiver_nonce = randomNonce();
  return { id: "12345678-1234-4321-8123-123456789abc", kind: "keys", state: "claimed", receiver_public_key: receiver,
    approver_public_key: approver, account_public_key: pairKeys().publicKey,
    account: { id: "alice", username: "alice", display_name: "Алиса", avatar_url: null }, device_name: "Chrome · Windows",
    created_at: "", expires_at: "", transferred_keys: false, commitment: await commitNonce(receiver, receiver_nonce),
    receiver_nonce, approver_nonce: randomNonce() };
}

describe("number matching", () => {
  it("gives both screens the same two-digit number for the same transcript", async () => {
    const value = await flow();
    const number = await keyNumber(value);
    expect(number).toBeGreaterThanOrEqual(10);
    expect(number).toBeLessThanOrEqual(99);
    expect(await keyNumber({ ...value })).toBe(number);
    expect(await commitmentMatches(value)).toBe(true);
  });

  it("rejects a revealed number that differs from the commitment", async () => {
    const value = await flow();
    expect(await commitmentMatches({ ...value, receiver_nonce: randomNonce() })).toBe(false);
    expect(await commitmentMatches({ ...value, receiver_public_key: pairKeys().publicKey })).toBe(false);
  });

  it("changes when any key in the transcript is swapped", async () => {
    const value = await flow();
    const numbers = new Set<number>();
    // Подмена ключа даёт случайное другое число: из 40 подмен совпасть могут единицы.
    for (let i = 0; i < 40; i++) numbers.add(await keyNumber({ ...value, approver_public_key: pairKeys().publicKey }));
    expect(numbers.size).toBeGreaterThan(20);
  });

  it("offers three distinct choices including the right one", () => {
    for (let i = 0; i < 200; i++) {
      const correct = 10 + (i % 90);
      const choices = numberChoices(correct);
      expect(new Set(choices).size).toBe(3);
      expect(choices).toContain(correct);
      expect(choices.every((value) => value >= 10 && value <= 99)).toBe(true);
    }
  });
});
