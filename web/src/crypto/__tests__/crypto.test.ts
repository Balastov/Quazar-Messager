import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { describe, expect, it } from "vitest";
import { encryptMessage, decryptMessage, isEncrypted } from "../message";
import { BackupError, decryptBackup, encryptBackup } from "../backup";
import { derivePublicKeyFromSeed } from "../webcrypto";
import { computeFingerprint, fingerprintMatches } from "../fingerprint";
import {
  acceptPeerKeyChange,
  clearAllTrustedKeys,
  markPeerVerified,
  resolvePeerTrust,
} from "../trust";

function randomKeyPair() {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: kp.secretKey,
  };
}

describe("ENC1 message crypto", () => {
  it("round-trips plaintext", async () => {
    const recipient = randomKeyPair();
    const ciphertext = encryptMessage("привет, quazar", recipient.publicKey);
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(ciphertext.startsWith("ENC1:")).toBe(true);

    const plain = await decryptMessage(ciphertext, { seed: recipient.secretKey });
    expect(plain).toBe("привет, quazar");
  });

  it("fails with wrong key", async () => {
    const recipient = randomKeyPair();
    const other = randomKeyPair();
    const ciphertext = encryptMessage("secret", recipient.publicKey);
    const plain = await decryptMessage(ciphertext, { seed: other.secretKey });
    expect(plain).toBeNull();
  });
});

describe("ENC2 dual-box message crypto", () => {
  it("recipient and sender can both decrypt", async () => {
    const recipient = randomKeyPair();
    const sender = randomKeyPair();
    const ciphertext = encryptMessage("привет, quazar", recipient.publicKey, sender.publicKey);
    expect(ciphertext.startsWith("ENC2:")).toBe(true);
    expect(isEncrypted(ciphertext)).toBe(true);

    const asRecipient = await decryptMessage(ciphertext, { seed: recipient.secretKey });
    const asSender = await decryptMessage(ciphertext, { seed: sender.secretKey });
    expect(asRecipient).toBe("привет, quazar");
    expect(asSender).toBe("привет, quazar");
  });

  it("fails for a third party", async () => {
    const recipient = randomKeyPair();
    const sender = randomKeyPair();
    const other = randomKeyPair();
    const ciphertext = encryptMessage("secret", recipient.publicKey, sender.publicKey);
    const plain = await decryptMessage(ciphertext, { seed: other.secretKey });
    expect(plain).toBeNull();
  });
});

describe("key backup", () => {
  it("round-trips the identity seed", async () => {
    const seed = nacl.randomBytes(32);
    const blob = await encryptBackup(seed, "correct horse");
    expect(blob.startsWith("ENC_BACKUP:v1:")).toBe(true);

    const restored = await decryptBackup(blob, "correct horse");
    expect(restored.seed).toEqual(seed);
    expect(restored.publicKey).toBe(derivePublicKeyFromSeed(seed));
  });

  it("rejects a wrong password", async () => {
    const blob = await encryptBackup(nacl.randomBytes(32), "correct horse");
    await expect(decryptBackup(blob, "wrong horse")).rejects.toBeInstanceOf(BackupError);
  });

  it("lets a second device read its own outgoing messages", async () => {
    // Устройство A: ключ аккаунта, исходящее сообщение и резервная копия.
    const accountSeed = nacl.randomBytes(32);
    const peer = randomKeyPair();
    const outgoing = encryptMessage(
      "пишу с ноутбука",
      peer.publicKey,
      derivePublicKeyFromSeed(accountSeed)
    );
    const blob = await encryptBackup(accountSeed, "backup-password");

    // Устройство B восстанавливает тот же ключ и читает историю.
    const { seed } = await decryptBackup(blob, "backup-password");
    expect(await decryptMessage(outgoing, { seed })).toBe("пишу с ноутбука");
  });
});

describe("fingerprint", () => {
  it("is stable and order-independent", async () => {
    const a = randomKeyPair().publicKey;
    const b = randomKeyPair().publicKey;
    const f1 = await computeFingerprint(a, b);
    const f2 = await computeFingerprint(b, a);
    expect(fingerprintMatches(f1, f2)).toBe(true);
    expect(f1.replace(/\s/g, "").length).toBe(60);
  });
});

describe("TOFU trust", () => {
  it("marks first key as new, then detects change", async () => {
    clearAllTrustedKeys();
    const me = randomKeyPair().publicKey;
    const peerA = randomKeyPair().publicKey;
    const peerB = randomKeyPair().publicKey;

    const first = await resolvePeerTrust("user-1", me, peerA);
    expect(first.status).toBe("new");

    const again = await resolvePeerTrust("user-1", me, peerA);
    expect(again.status).toBe("unverified");

    await markPeerVerified("user-1", me);
    const verified = await resolvePeerTrust("user-1", me, peerA);
    expect(verified.status).toBe("ok");

    const changed = await resolvePeerTrust("user-1", me, peerB);
    expect(changed.status).toBe("changed");

    await acceptPeerKeyChange("user-1", me, peerB);
    const accepted = await resolvePeerTrust("user-1", me, peerB);
    expect(accepted.status).toBe("ok");
  });
});
