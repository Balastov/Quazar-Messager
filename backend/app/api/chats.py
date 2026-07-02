from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.chat import Chat, ChatMember
from app.models.user import User
from app.schemas.chat import ChatOut, CreateDirectChat, CreateGroupChat

router = APIRouter(prefix="/chats", tags=["chats"])


async def _load_chat(chat_id: str, db: AsyncSession) -> Chat:
    result = await db.execute(
        select(Chat)
        .where(Chat.id == chat_id)
        .options(selectinload(Chat.members).selectinload(ChatMember.user))
    )
    chat = result.scalar_one_or_none()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
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
        .order_by(Chat.created_at.desc())
    )
    return result.scalars().unique().all()


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
