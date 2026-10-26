from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.attachment import Attachment
from app.models.call import Call
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.user import User
from app.schemas.chat import (
    ChatOut,
    CreateDirectChat,
    CreateGroupChat,
    SetChatBackground,
    SetChatTtl,
)
from app.ws.hub import manager

router = APIRouter(prefix="/chats", tags=["chats"])


async def _attach_last_activity(chats: list[Chat], db: AsyncSession) -> None:
    """Последняя активность чата: последнее сообщение, последний звонок или создание."""
    chat_ids = [c.id for c in chats]
    if not chat_ids:
        return
    last_message = dict(
        (
            await db.execute(
                select(Message.chat_id, func.max(Message.created_at))
                .where(Message.chat_id.in_(chat_ids))
                .group_by(Message.chat_id)
            )
        ).all()
    )
    last_call = dict(
        (
            await db.execute(
                select(Call.chat_id, func.max(Call.started_at))
                .where(Call.chat_id.in_(chat_ids))
                .group_by(Call.chat_id)
            )
        ).all()
    )
    for chat in chats:
        candidates = [chat.created_at, last_message.get(chat.id), last_call.get(chat.id)]
        chat.last_activity_at = max(ts for ts in candidates if ts is not None)


async def _load_chat(chat_id: str, db: AsyncSession) -> Chat:
    result = await db.execute(
        select(Chat)
        .where(Chat.id == chat_id)
        .options(selectinload(Chat.members).selectinload(ChatMember.user))
    )
    chat = result.scalar_one_or_none()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    await _attach_last_activity([chat], db)
    return chat


@router.get("", response_model=list[ChatOut])
async def list_chats(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(Chat)
        .join(ChatMember)
        .where(ChatMember.user_id == current_user.id)
        .options(selectinload(Chat.members).selectinload(ChatMember.user))
    )
    chats = list(result.scalars().unique().all())
    await _attach_last_activity(chats, db)
    # Свежие сверху.
    chats.sort(key=lambda c: c.last_activity_at, reverse=True)
    return chats


@router.post("/direct", response_model=ChatOut, status_code=status.HTTP_201_CREATED)
async def create_direct_chat(
    body: CreateDirectChat,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if body.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot create chat with yourself")

    # Проверяем, существует ли уже direct-чат между этими двумя
    existing = await db.execute(
        select(Chat)
        .join(ChatMember, ChatMember.chat_id == Chat.id)
        .where(
            Chat.type == "direct",
            ChatMember.user_id == current_user.id,
        )
        .options(selectinload(Chat.members))
    )
    for chat in existing.scalars().unique():
        member_ids = {m.user_id for m in chat.members}
        if body.user_id in member_ids:
            return await _load_chat(chat.id, db)

    # Проверяем, что собеседник существует
    result = await db.execute(select(User).where(User.id == body.user_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="User not found")

    chat = Chat(type="direct")
    db.add(chat)
    await db.flush()

    db.add(ChatMember(chat_id=chat.id, user_id=current_user.id, role="owner"))
    db.add(ChatMember(chat_id=chat.id, user_id=body.user_id, role="member"))
    await db.commit()

    return await _load_chat(chat.id, db)


@router.post("/saved", response_model=ChatOut)
async def open_saved_chat(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """«Избранное» — чат с самим собой. Один на человека: создаётся при первом открытии."""
    existing = (
        await db.execute(
            select(Chat.id)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .where(Chat.type == "saved", ChatMember.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if existing:
        return await _load_chat(existing, db)
    chat = Chat(type="saved")
    db.add(chat)
    await db.flush()
    db.add(ChatMember(chat_id=chat.id, user_id=current_user.id, role="owner"))
    await db.commit()
    return await _load_chat(chat.id, db)


@router.post("/group", response_model=ChatOut, status_code=status.HTTP_201_CREATED)
async def create_group_chat(
    body: CreateGroupChat,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    chat = Chat(type="group", name=body.name)
    db.add(chat)
    await db.flush()

    member_ids = list({current_user.id, *body.member_ids})
    for uid in member_ids:
        role = "owner" if uid == current_user.id else "member"
        db.add(ChatMember(chat_id=chat.id, user_id=uid, role=role))

    await db.commit()
    return await _load_chat(chat.id, db)


@router.get("/{chat_id}", response_model=ChatOut)
async def get_chat(
    chat_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    chat = await _load_chat(chat_id, db)
    member_ids = {m.user_id for m in chat.members}
    if current_user.id not in member_ids:
        raise HTTPException(status_code=403, detail="Access denied")
    return chat


async def _member_chat(chat_id: str, user: User, db: AsyncSession) -> Chat:
    chat = (await db.execute(select(Chat).where(Chat.id == chat_id))).scalar_one_or_none()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    is_member = (
        await db.execute(
            select(ChatMember).where(ChatMember.chat_id == chat_id, ChatMember.user_id == user.id)
        )
    ).scalar_one_or_none()
    if not is_member:
        raise HTTPException(status_code=403, detail="Access denied")
    return chat


async def _background_changed(chat: Chat, user: User, db: AsyncSession) -> None:
    """Фон чата общий: меняется сразу у всех участников."""
    member_ids = (
        await db.execute(select(ChatMember.user_id).where(ChatMember.chat_id == chat.id))
    ).scalars().all()
    await manager.broadcast_to_users(
        list(member_ids),
        {
            "type": "chat_background",
            "chat_id": chat.id,
            "background": chat.background,
            "changed_by": user.id,
        },
    )


@router.put("/{chat_id}/background", status_code=status.HTTP_204_NO_CONTENT)
async def set_chat_background(
    chat_id: str,
    body: SetChatBackground,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Общий фон чата — менять может любой участник. Картинку клиент заранее загружает
    в /chats/{chat_id}/attachments (зашифрованной), ключ к ней — в payload."""
    chat = await _member_chat(chat_id, current_user, db)
    attachment = (
        await db.execute(
            select(Attachment).where(
                Attachment.id == body.attachment_id,
                Attachment.chat_id == chat_id,
                Attachment.uploader_id == current_user.id,
                Attachment.message_id.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not attachment:
        raise HTTPException(status_code=422, detail="Attachment not found")
    chat.background = body.payload
    chat.background_attachment_id = attachment.id
    await db.commit()
    await _background_changed(chat, current_user, db)


@router.delete("/{chat_id}/background", status_code=status.HTTP_204_NO_CONTENT)
async def remove_chat_background(
    chat_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    chat = await _member_chat(chat_id, current_user, db)
    chat.background = None
    chat.background_attachment_id = None
    await db.commit()
    await _background_changed(chat, current_user, db)


@router.put("/{chat_id}/ttl", status_code=status.HTTP_204_NO_CONTENT)
async def set_chat_ttl(
    chat_id: str,
    body: SetChatTtl,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Исчезающие сообщения. В личном чате включает любой из двоих, в группе — владелец и админы.
    Действует на сообщения, отправленные после включения."""
    chat = await _member_chat(chat_id, current_user, db)
    if chat.type == "group":
        role = (
            await db.execute(
                select(ChatMember.role).where(
                    ChatMember.chat_id == chat_id, ChatMember.user_id == current_user.id
                )
            )
        ).scalar_one()
        if role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Менять могут владелец и админы группы")
    chat.ttl_seconds = body.ttl_seconds
    await db.commit()
    member_ids = (
        await db.execute(select(ChatMember.user_id).where(ChatMember.chat_id == chat_id))
    ).scalars().all()
    await manager.broadcast_to_users(
        list(member_ids),
        {
            "type": "chat_ttl",
            "chat_id": chat_id,
            "ttl_seconds": chat.ttl_seconds,
            "changed_by": current_user.id,
        },
    )
