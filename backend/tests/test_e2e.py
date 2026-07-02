import base64
import binascii
import unittest

from app.core.e2e import X25519_PUBLIC_KEY_BYTES, decode_public_key_b64


class TestPublicKeyValidation(unittest.TestCase):
    def test_valid_32_byte_key(self):
        raw = b"\x01" * 32
        encoded = base64.b64encode(raw).decode()
        self.assertEqual(decode_public_key_b64(encoded), raw)

    def test_rejects_invalid_base64(self):
        with self.assertRaises(ValueError):
            decode_public_key_b64("not!!!valid")

    def test_rejects_wrong_length(self):
        raw = b"\x01" * 16
        encoded = base64.b64encode(raw).decode()
        with self.assertRaises(ValueError) as ctx:
            decode_public_key_b64(encoded)
        self.assertIn(str(X25519_PUBLIC_KEY_BYTES), str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
