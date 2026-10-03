import re

PHONE_RE = re.compile(r"^\+7\d{10}$")


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
