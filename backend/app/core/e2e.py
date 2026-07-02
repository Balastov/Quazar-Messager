import base64
import binascii

X25519_PUBLIC_KEY_BYTES = 32


def decode_public_key_b64(public_key: str) -> bytes:
    """Decode and validate a base64 X25519 public key (must be 32 bytes)."""
    try:
        key_bytes = base64.b64decode(public_key, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("public_key must be valid base64") from exc

    if len(key_bytes) != X25519_PUBLIC_KEY_BYTES:
        raise ValueError(f"public_key must decode to {X25519_PUBLIC_KEY_BYTES} bytes")

    return key_bytes
