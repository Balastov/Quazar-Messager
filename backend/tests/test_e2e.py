import unittest

from app.core.e2e import X25519_PUBLIC_KEY_BYTES, decode_public_key_b64


class TestPublicKeyValidation(unittest.TestCase):
    def test_valid_32_byte_key(self):
        import base64

        raw = b"\x01" * 32
        encoded = base64.b64encode(raw).decode()
        self.assertEqual(decode_public_key_b64(encoded), raw)

    def test_rejects_invalid_base64(self):
        with self.assertRaises(ValueError):
            decode_public_key_b64("not!!!valid")

    def test_rejects_wrong_length(self):
        import base64

        raw = b"\x01" * 16
        encoded = base64.b64encode(raw).decode()
        with self.assertRaises(ValueError) as ctx:
            decode_public_key_b64(encoded)
        self.assertIn(str(X25519_PUBLIC_KEY_BYTES), str(ctx.exception))


class TestDirectChatPartners(unittest.IsolatedAsyncioTestCase):
    async def test_get_direct_chat_partner_ids_empty_without_db(self):
        from app.core.e2e_users import get_direct_chat_partner_ids

        class FakeResult:
            def all(self):
                return []

        class FakeDb:
            async def execute(self, _query):
                return FakeResult()

        partners = await get_direct_chat_partner_ids("user-1", FakeDb())
        self.assertEqual(partners, [])


if __name__ == "__main__":
    unittest.main()
