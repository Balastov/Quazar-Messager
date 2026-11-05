"""Invalidate cached profile images saved before avatar URLs were versioned."""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


async def migrate_legacy_avatar_urls(conn: AsyncConnection) -> None:
    # Existing files may already contain a replacement image hidden by the old URL's cache.
    # Only local, unversioned profile avatars are touched; repeated startup is a no-op.
    await conn.execute(text(r"""
        UPDATE users SET avatar_url = avatar_url || '?v=profile-cache-1'
        WHERE avatar_url ~ '^/media/avatars/[0-9a-fA-F-]{36}\.(jpg|png|webp|gif)$'
    """))
