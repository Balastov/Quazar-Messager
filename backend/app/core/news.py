"""Official release news and personal notices from the news bot.

Деплой кладёт текст новости черновиком. Суперпользователь читает его в «Чёрной дыре», правит
и одобряет — только тогда новость снимает список получателей и уходит каждому один раз.
"""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, literal, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.release_notes import ReleaseNotes
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.news import NewsDelivery, NewsInbox, NewsNotice, NewsRelease
from app.models.user import User

BOT_USERNAME = "Quazar_news_bot"
BOT_PHONE = "bot:quazar-news"
BASELINE_VERSION = (0, 20, 3)  # Existing history is not broadcast when the feature is enabled.
BATCH = 100
# В объединённом и отредактированном черновике пунктов может быть больше, чем в файле выпуска.
MAX_CHANGES = 20
MAX_TITLE = 100
MAX_CHANGE = 400


def _version(value: str) -> tuple[int, ...]:
    return tuple(map(int, value.split(".")))


def compose(version: str, title: str, changes: list[str] | tuple[str, ...]) -> str:
    return ReleaseNotes(version, title, tuple(changes)).message


def clean_text(title: object, changes: object) -> tuple[str, list[str]]:
    """Тот же формат, что у файла выпуска: короткий заголовок и однострочные пункты."""
    def single_line(value: object, limit: int) -> bool:
        return isinstance(value, str) and 0 < len(value.strip()) <= limit and not any(ord(ch) < 32 for ch in value)
    if not single_line(title, MAX_TITLE):
        raise HTTPException(status_code=422, detail=f"Заголовок — одна строка до {MAX_TITLE} символов")
    if not isinstance(changes, list) or not 1 <= len(changes) <= MAX_CHANGES:
        raise HTTPException(status_code=422, detail=f"Нужно от 1 до {MAX_CHANGES} пунктов")
    if not all(single_line(change, MAX_CHANGE) for change in changes):
        raise HTTPException(status_code=422, detail=f"Каждый пункт — одна строка до {MAX_CHANGE} символов")
    return title.strip(), [change.strip() for change in changes]


async def bot_user(db: AsyncSession) -> User:
    await db.execute(text("SELECT pg_advisory_xact_lock(742039101)"))
    bot = (await db.execute(select(User).where(User.phone == BOT_PHONE, User.is_official.is_(True)))).scalar_one_or_none()
    if bot is None:
        bot = User(username=BOT_USERNAME, phone=BOT_PHONE, password_hash=None, phone_discoverable=False, is_official=True)
        db.add(bot)
        await db.commit()
    return bot


def _humans():
    return select(User.id).where(User.is_official.is_(False), or_(User.phone.is_(None), ~User.phone.like("bot:%")))


async def notify(db: AsyncSession, user_id: str, key: str, payload: str) -> bool:
    """Ставит личное сообщение от news_bot в очередь; повтор с тем же key ничего не делает."""
    created = (await db.execute(insert(NewsNotice).values(key=key, user_id=user_id, payload=payload)
        .on_conflict_do_nothing(index_elements=[NewsNotice.key]).returning(NewsNotice.id))).scalar_one_or_none()
    return created is not None


async def add_draft(db: AsyncSession, notes: ReleaseNotes) -> str:
    """Деплой версии: черновик новости. Неодобренные черновики прежних версий входят в него."""
    if _version(notes.version) <= BASELINE_VERSION:
        return "baseline"
    await db.execute(text("SELECT pg_advisory_xact_lock(742039102)"))
    existing = await db.get(NewsRelease, notes.version)
    if existing:
        # Повторный деплой той же версии. Пока черновик никто не правил, берём свежий текст из файла.
        if existing.status == "draft" and existing.updated_by_id is None and existing.versions == [notes.version]:
            existing.title, existing.changes = notes.title, list(notes.changes)
            existing.payload = notes.message
            existing.revision += 1
            await db.commit()
            return "refreshed"
        return "exists"
    known = (await db.execute(select(NewsRelease.version, NewsRelease.status))).all()
    if any(_version(version) > _version(notes.version) for version, _ in known):
        return "older"  # A rollback must not announce an older version as new.
    pending = sorted((await db.execute(select(NewsRelease).where(NewsRelease.status == "draft"))).scalars(),
                     key=lambda row: _version(row.version))
    changes: list[str] = []
    for change in [c for row in pending for c in (row.changes or [])] + list(notes.changes):
        if change not in changes:
            changes.append(change)
    versions = [v for row in pending for v in (row.versions or [row.version])] + [notes.version]
    db.add(NewsRelease(version=notes.version, status="draft", title=notes.title, changes=changes, versions=versions,
                       payload=compose(notes.version, notes.title, changes), revision=0))
    for row in pending:
        row.status, row.merged_into = "merged", notes.version
    await db.flush()
    together = f" (вместе с {', '.join(versions[:-1])})" if len(versions) > 1 else ""
    for (user_id,) in (await db.execute(select(User.id).where(User.is_superuser.is_(True), User.blocked_at.is_(None)))).all():
        await notify(db, user_id, f"news-draft:{notes.version}:{user_id}",
            f"Готов текст новости об обновлении Quazar {notes.version}{together}. "
            "Проверьте его и опубликуйте: «Чёрная дыра» → «Новости». Пока вы его не одобрите, никто ничего не получит.")
    await db.commit()
    return "merged" if pending else "draft"


async def edit_draft(db: AsyncSession, version: str, title: object, changes: object, revision: int, editor_id: str) -> NewsRelease:
    title, changes = clean_text(title, changes)
    row = await _draft(db, version, revision)
    row.title, row.changes, row.payload = title, changes, compose(version, title, changes)
    row.revision += 1
    row.updated_at, row.updated_by_id = datetime.now(timezone.utc), editor_id
    await db.commit()
    return row


async def _draft(db: AsyncSession, version: str, revision: int) -> NewsRelease:
    row = (await db.execute(select(NewsRelease).where(NewsRelease.version == version).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Новость не найдена")
    if row.status != "draft":
        raise HTTPException(status_code=409, detail="Эту новость уже опубликовали, пропустили или объединили с новой")
    if row.revision != revision:
        raise HTTPException(status_code=409, detail="Текст успели изменить. Обновите страницу и проверьте его ещё раз")
    return row


async def publish(db: AsyncSession, version: str, revision: int, publisher_id: str | None) -> int:
    """Одобрение: снимок получателей на этот момент; каждый получит ровно тот текст, что видел одобряющий."""
    await db.execute(text("SELECT pg_advisory_xact_lock(742039102)"))
    row = await _draft(db, version, revision)
    clean_text(row.title, row.changes)
    newer = (await db.execute(select(NewsRelease.version).where(NewsRelease.status == "published"))).scalars().all()
    if any(_version(value) > _version(version) for value in newer):
        raise HTTPException(status_code=409, detail="Уже опубликована более новая версия")
    row.payload = compose(version, row.title, row.changes)
    row.status, row.published_at, row.published_by_id = "published", datetime.now(timezone.utc), publisher_id
    result = await db.execute(insert(NewsDelivery).from_select(
        [NewsDelivery.version, NewsDelivery.user_id], select(literal(version), _humans().subquery().c.id)))
    await db.commit()
    return result.rowcount


async def skip(db: AsyncSession, version: str, revision: int, editor_id: str) -> None:
    row = await _draft(db, version, revision)
    row.status, row.updated_at, row.updated_by_id = "skipped", datetime.now(timezone.utc), editor_id
    row.revision += 1
    await db.commit()


async def recipients(db: AsyncSession) -> int:
    return (await db.execute(select(func.count()).select_from(_humans().subquery()))).scalar_one()


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


async def _deliver(db: AsyncSession, item: NewsDelivery | NewsNotice, payload: str) -> None:
    """Сообщение и ссылка на него в очереди сохраняются вместе: повтор после сбоя берёт тот же ID."""
    from app.api.messages import publish_message

    message = await db.get(Message, item.message_id) if item.message_id else None
    if message is None:
        bot = (await db.execute(select(User).where(User.phone == BOT_PHONE, User.is_official.is_(True)))).scalar_one()
        chat = await _inbox(db, item.user_id, bot.id)
        message = Message(chat_id=chat.id, sender_id=bot.id, payload=payload)
        db.add(message)
        await db.flush()
        item.message_id = message.id
        await db.commit()
    else:
        chat = await db.get(Chat, message.chat_id)
    await publish_message(db, chat, message)
    item.published_at = datetime.now(timezone.utc)
    await db.commit()


async def send_pending(db: AsyncSession) -> int:
    sent = 0
    for _ in range(BATCH):
        item = (await db.execute(select(NewsDelivery).join(NewsRelease, NewsRelease.version == NewsDelivery.version)
            .where(NewsDelivery.published_at.is_(None), NewsRelease.status == "published")
            .order_by(NewsRelease.created_at, NewsDelivery.user_id)
            .limit(1).with_for_update(of=NewsDelivery, skip_locked=True))).scalar_one_or_none()
        if item is None:
            break
        release = await db.get(NewsRelease, item.version)
        await _deliver(db, item, release.payload)
        sent += 1
    for _ in range(BATCH):
        notice = (await db.execute(select(NewsNotice).where(NewsNotice.published_at.is_(None))
            .order_by(NewsNotice.created_at, NewsNotice.id).limit(1).with_for_update(skip_locked=True))).scalar_one_or_none()
        if notice is None:
            break
        await _deliver(db, notice, notice.payload)
        sent += 1
    return sent
