"""Official release news: one stored message per version and registered person."""
from datetime import datetime, timezone

from sqlalchemy import literal, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.release_notes import ReleaseNotes
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.news import NewsDelivery, NewsInbox, NewsRelease
from app.models.user import User

BOT_USERNAME = "Quazar_news_bot"
BOT_PHONE = "bot:quazar-news"
BASELINE_VERSION = (0, 20, 3)  # Existing history is not broadcast when the feature is enabled.
BATCH = 100


async def bot_user(db: AsyncSession) -> User:
    await db.execute(text("SELECT pg_advisory_xact_lock(742039101)"))
    bot = (await db.execute(select(User).where(User.phone == BOT_PHONE, User.is_official.is_(True)))).scalar_one_or_none()
    if bot is None:
        bot = User(username=BOT_USERNAME, phone=BOT_PHONE, password_hash=None, phone_discoverable=False, is_official=True)
        db.add(bot)
        await db.commit()
    return bot


async def enqueue_release(db: AsyncSession, notes: ReleaseNotes) -> int:
    """Snapshot registered humans exactly once; deployments of the same version are harmless."""
    if tuple(map(int, notes.version.split("."))) <= BASELINE_VERSION:
        return 0
    await db.execute(text("SELECT pg_advisory_xact_lock(742039102)"))
    previous = await db.get(NewsRelease, notes.version)
    if previous:
        if previous.payload != notes.message:
            raise ValueError("This version already has different release news; use a new version")
        return 0
    known_versions = (await db.execute(select(NewsRelease.version))).scalars().all()
    if any(tuple(map(int, value.split("."))) > tuple(map(int, notes.version.split("."))) for value in known_versions):
        return 0  # A rollback must not broadcast an older version as new.
    created = (await db.execute(insert(NewsRelease).values(version=notes.version, payload=notes.message)
        .on_conflict_do_nothing(index_elements=[NewsRelease.version]).returning(NewsRelease.version))).scalar_one_or_none()
    if created is None:
        existing = await db.get(NewsRelease, notes.version)
        if existing.payload != notes.message:
            raise ValueError("This version already has different release news; use a new version")
        return 0
    result = await db.execute(insert(NewsDelivery).from_select(
        [NewsDelivery.version, NewsDelivery.user_id],
        select(literal(notes.version), User.id).where(User.is_official.is_(False), or_(User.phone.is_(None), ~User.phone.like("bot:%"))),
    ))
    await db.commit()
    return result.rowcount


async def _inbox(db: AsyncSession, user_id: str, bot_id: str) -> Chat:
    # Two release workers can target one person at the same time; keep one news chat.
    await db.execute(select(User.id).where(User.id == user_id).with_for_update())
    inbox = await db.get(NewsInbox, user_id)
    if inbox:
        return await db.get(Chat, inbox.chat_id)
    chat = Chat(type="news", name=BOT_USERNAME)
    db.add(chat)
    await db.flush()
    db.add_all([ChatMember(chat_id=chat.id, user_id=bot_id, role="owner"),
        ChatMember(chat_id=chat.id, user_id=user_id, role="member", last_read_at=chat.created_at)])
    db.add(NewsInbox(user_id=user_id, chat_id=chat.id))
    return chat


async def send_pending(db: AsyncSession) -> int:
    from app.api.messages import publish_message

    sent = 0
    for _ in range(BATCH):
        item = (await db.execute(select(NewsDelivery).join(NewsRelease, NewsRelease.version == NewsDelivery.version)
            .where(NewsDelivery.published_at.is_(None)).order_by(NewsRelease.created_at, NewsDelivery.user_id)
            .limit(1).with_for_update(of=NewsDelivery, skip_locked=True))).scalar_one_or_none()
        if item is None:
            break
        message = await db.get(Message, item.message_id) if item.message_id else None
        if message is None:
            bot = (await db.execute(select(User).where(User.phone == BOT_PHONE, User.is_official.is_(True)))).scalar_one()
            chat = await _inbox(db, item.user_id, bot.id)
            release = await db.get(NewsRelease, item.version)
            message = Message(chat_id=chat.id, sender_id=bot.id, payload=release.payload)
            db.add(message)
            await db.flush()
            item.message_id = message.id
            # Saving the message and its queue reference is atomic. A retry reuses its ID.
            await db.commit()
        else:
            chat = await db.get(Chat, message.chat_id)
        await publish_message(db, chat, message)
        item.published_at = datetime.now(timezone.utc)
        await db.commit()
        sent += 1
    return sent
