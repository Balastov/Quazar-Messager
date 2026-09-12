# E2E Threat Model — Quazar Messager

## Goal

Protect **message content** in direct chats from the server and passive network observers.
This is not a full Signal Protocol deployment.

## Assets

- Message plaintext (direct chats)
- Identity seed / private key material on the device
- Password-protected key backup ciphertext

## Adversaries

| Adversary | In scope? | Mitigations |
|-----------|-----------|-------------|
| Honest-but-curious server | Yes | ENC1 ciphertext only; backup is AES-GCM ciphertext |
| Network eavesdropper | Yes | TLS (deploy requirement) + E2E payload |
| Server pubkey MITM | Partially | TOFU + safety numbers + key-change block |
| XSS / malicious extension | Partially | Seed in IndexedDB (not localStorage string); CSP recommended. **Not fully solved** — XSS can still abuse crypto APIs in-page |
| Lost device | Partially | Encrypted backup + rotate; no remote wipe yet |
| Metadata observer | No | Server sees who talks to whom, when, sizes |
| Group E2E | No | Groups are explicitly plaintext |

## Guarantees (after phases 1–4)

1. Direct messages are encrypted client-side (`ENC1`) when peer key exists.
2. No silent plaintext fallback for direct chats.
3. Peer key change is visible and blocks send until confirmed.
4. Users can verify fingerprints out-of-band.
5. Password-protected backup can restore keys on a new browser profile.
6. Key rotation requires account password and notifies direct partners.

## Non-guarantees

- E2E does **not** fully protect against XSS on the Quazar origin.
- Groups are **not** end-to-end encrypted.
- Forward secrecy is limited to ephemeral sender keys per message; no Double Ratchet.
- Multi-device sync is only via backup restore (not linked devices).

## Operational requirements

- Set a strong `JWT_SECRET`.
- Set `CORS_ORIGINS` to explicit frontend origins in production (not `*`).
- Terminate TLS in front of API and web.
- Prefer a Content-Security-Policy on the web app host that blocks inline scripts and unknown origins.
