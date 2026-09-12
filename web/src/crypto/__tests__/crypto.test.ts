import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { describe, expect, it } from "vitest";
import { encryptMessage, decryptMessage, isEncrypted } from "../message";
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
