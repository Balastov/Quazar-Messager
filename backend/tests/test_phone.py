import unittest

from app.core.phone import normalize_ru_phone


class TestPhoneNormalize(unittest.TestCase):
    def test_plus7(self):
        self.assertEqual(normalize_ru_phone("+7 (999) 123-45-67"), "+79991234567")

    def test_eight(self):
        self.assertEqual(normalize_ru_phone("89991234567"), "+79991234567")

    def test_ten_digits(self):
        self.assertEqual(normalize_ru_phone("9991234567"), "+79991234567")

    def test_invalid(self):
        with self.assertRaises(ValueError):
            normalize_ru_phone("12345")


if __name__ == "__main__":
    unittest.main()
