"""Star-local display names; account profile and @username remain unchanged."""
import unicodedata
from typing import TypeVar

import regex
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.censor import find_violation, violation_message
from app.models.star import StarMember
from app.models.user import User

MAX_PSEUDONYM = 64
T = TypeVar("T")


def normalize_pseudonym(raw: str | None) -> str | None:
    if raw is None:
        return None
    value = unicodedata.normalize("NFC", raw.strip())
    if not value:
        return None
    if len(value) > 1024:
        raise ValueError("Псевдоним слишком длинный")
    # Preserve emoji joiners and marks, but reject invisible text and bidi/control overrides.
    if regex.search(r"[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]", value) or any(
        regex.fullmatch(r"\p{Cf}", ch) and ch not in {"\u200c", "\u200d"} for ch in value):
        raise ValueError("Псевдоним содержит невидимые или управляющие символы")
    symbols = [symbol for symbol in regex.findall(r"\X", value) if regex.search(r"[\p{L}\p{N}\p{P}\p{S}\p{Zs}]", symbol)]
    if not regex.search(r"[\p{L}\p{N}\p{P}\p{S}]", value):
        raise ValueError("Псевдоним не может состоять из невидимых символов")
    han_only = all(regex.fullmatch(r"\p{Script=Han}\p{M}*", symbol) for symbol in symbols)
    if len(symbols) < (1 if han_only else 3):
        raise ValueError("Псевдоним — не менее 3 символов; для иероглифов можно короче")
    if len(symbols) > MAX_PSEUDONYM:
        raise ValueError(f"Псевдоним — не длиннее {MAX_PSEUDONYM} символов")
    if category := find_violation(value.replace("\u200c", "").replace("\u200d", ""), nickname=False):
        raise ValueError(f"Псевдоним содержит {violation_message(category)}")
    return value


def can_change_pseudonym(actor_id: str, actor_role: str, target_id: str, target_role: str) -> bool:
    return actor_id == target_id or (actor_role in {"owner", "admin"} and target_role not in {"owner", "admin"})


async def name_in_star(db: AsyncSession, star_id: str, user: User | None) -> str | None:
    if user is None:
        return None
    name = (await db.execute(select(StarMember.pseudonym).where(
        StarMember.star_id == star_id, StarMember.user_id == user.id))).scalar_one_or_none()
    return name or user.display_name


async def in_star(db: AsyncSession, star_id: str, value: T) -> T:
    """Apply viewer-star pseudonyms to all StarUserOut objects in a response/event, in one query."""
    profiles: list = []
    def collect(item):
        if isinstance(item, BaseModel):
            if hasattr(item, "pseudonym") and hasattr(item, "username") and hasattr(item, "id"):
                profiles.append(item)
            else:
                for key in type(item).model_fields:
                    collect(getattr(item, key))
        elif isinstance(item, dict):
            if "pseudonym" in item and "username" in item and "id" in item:
                profiles.append(item)
            else:
                for child in item.values():
                    collect(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                collect(child)
    collect(value)
    if not profiles:
        return value
    ids = {item["id"] if isinstance(item, dict) else item.id for item in profiles}
    rows = (await db.execute(select(StarMember.user_id, StarMember.pseudonym, StarMember.pseudonym_version)
        .where(StarMember.star_id == star_id, StarMember.user_id.in_(ids)))).all()
    names = {uid: (name, version) for uid, name, version in rows}
    for profile in profiles:
        uid = profile["id"] if isinstance(profile, dict) else profile.id
        name, version = names.get(uid, (None, 0))
        account_name = (profile.get("account_display_name") or profile.get("display_name", "")) if isinstance(profile, dict) else (profile.account_display_name or profile.display_name)
        fields = {"pseudonym": name, "pseudonym_star_id": star_id, "pseudonym_version": version, "display_name": name or account_name}
        if isinstance(profile, dict):
            profile.update(fields)
        else:
            for key, field in fields.items():
                setattr(profile, key, field)
    return value
