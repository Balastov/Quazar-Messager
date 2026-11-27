"""Номера телефонов в формате E.164: российские по-старому, остальные — по базе libphonenumber."""

import re

import phonenumbers

PHONE_RE = re.compile(r"^\+7\d{10}$")
INVALID = "Неверный номер телефона. Иностранный номер укажите с кодом страны, например +44 7911 123456"


def normalize_ru_phone(value: str) -> str:
    """
    Normalize Russian phone to +7XXXXXXXXXX.
    Accepts +7..., 8..., 7..., or 10 digits.
    """
    digits = re.sub(r"\D", "", value or "")
    if digits.startswith("8") and len(digits) == 11:
        digits = "7" + digits[1:]
    if digits.startswith("7") and len(digits) == 11:
        return f"+{digits}"
    if len(digits) == 10:
        return f"+7{digits}"
    raise ValueError("Phone must be a Russian number: +7 and 10 digits")


def is_valid_ru_phone(value: str) -> bool:
    try:
        return bool(PHONE_RE.match(normalize_ru_phone(value)))
    except ValueError:
        return False


def normalize_phone(value: str, region: str | None = "RU") -> str:
    """Любой номер → E.164. Без «+» номер читается в формате страны region (по умолчанию России).

    Номера +7 принимаются, как и раньше, по одной длине: на них уже заведены аккаунты,
    и вход по ним не должен зависеть от обновлений базы номеров."""
    raw = (value or "").strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("00") or (not raw.startswith("+") and digits.startswith("00")):
        raw, digits = "+" + digits[2:], digits[2:]
    international = raw.startswith("+")
    if international and digits.startswith("7") and len(digits) == 11:
        return "+" + digits
    if not international and (region or "RU") == "RU":
        try:
            return normalize_ru_phone(digits)
        except ValueError:
            pass
    if not digits or len(digits) > 15:
        raise ValueError(INVALID)
    try:
        number = phonenumbers.parse("+" + digits if international else digits, None if international else region)
    except phonenumbers.NumberParseException:
        raise ValueError(INVALID) from None
    if not phonenumbers.is_valid_number(number):
        raise ValueError(INVALID)
    result = phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)
    if result.startswith("+7") and not PHONE_RE.match(result):
        raise ValueError(INVALID)
    return result


def phone_region(phone: str) -> str | None:
    """Страна номера в E.164 (ISO 3166-1 alpha-2) или None."""
    try:
        number = phonenumbers.parse(phone, None)
    except phonenumbers.NumberParseException:
        return None
    # Номер вне известных диапазонов — берём главную страну его кода (+44 → GB).
    region = phonenumbers.region_code_for_number(number) or phonenumbers.region_code_for_country_code(number.country_code)
    return None if region in (None, "ZZ", "001") else region


def uses_call_check(phone: str) -> bool:
    """Звонок через Звонок — только для кода +7 (Россия и Казахстан); остальным код приходит в Telegram."""
    return phone.startswith("+7")
