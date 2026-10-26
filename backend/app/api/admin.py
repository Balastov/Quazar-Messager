"""«Чёрная дыра»: администрирование ресурса для его владельцев (users.is_superuser).

Всем остальным каждый адрес здесь отвечает тем же 404, что и несуществующий: о разделе не узнать.
Роль владельца ресурса видят и назначают только сами владельцы.
"""

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import presence, voice
from app.core.database import get_db
from app.core.deps import get_superuser
from app.models.chat import Chat
from app.models.message import Message
from app.models.moderation import UserReport
from app.models.star import Star, StarMember, StarMessage
from app.models.user import User
from app.ws.hub import manager

router = APIRouter(prefix="/admin", tags=["admin"], include_in_schema=False)

Super = Annotated[User, Depends(get_superuser)]
Db = Annotated[AsyncSession, Depends(get_db)]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


class AdminUserOut(BaseModel):
    id: str
    username: str
    first_name: str | None = None
    last_name: str | None = None
    phone: str
    created_at: datetime | None = None
    last_seen_at: datetime | None = None
    is_superuser: bool
    blocked_at: datetime | None
    blocked_reason: str | None
    online: bool = False

    model_config = {"from_attributes": True}


def _user_out(u: User) -> AdminUserOut:
    out = AdminUserOut.model_validate(u)
    out.online = presence.is_online(u.id)
    return out


class StatsOut(BaseModel):
    users: int
    online: int
    blocked: int
    stars: int
    chats: int
    messages_today: int
    open_reports: int


@router.get("/me", response_model=StatsOut)
async def admin_me(me: Super, db: Db):
    """Есть ли доступ (иначе 404) и общая сводка по ресурсу."""
    day_ago = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    count = lambda q: db.execute(q)  # noqa: E731
    users = (await count(select(func.count()).select_from(User))).scalar_one()
    blocked = (await count(select(func.count()).select_from(User).where(User.blocked_at.is_not(None)))).scalar_one()
    stars = (await count(select(func.count()).select_from(Star))).scalar_one()
    chats = (await count(select(func.count()).select_from(Chat))).scalar_one()
    messages = (await count(select(func.count()).select_from(Message).where(Message.created_at >= day_ago))).scalar_one()
    star_messages = (
        await count(select(func.count()).select_from(StarMessage).where(StarMessage.created_at >= day_ago))
    ).scalar_one()
    reports = (
        await count(select(func.count()).select_from(UserReport).where(UserReport.resolved_at.is_(None)))
    ).scalar_one()
    return StatsOut(
        users=users,
        online=len(manager.user_connections),
        blocked=blocked,
        stars=stars,
        chats=chats,
        messages_today=messages + star_messages,
        open_reports=reports,
    )


# --- Пользователи ----------------------------------------------------------------------


@router.get("/users", response_model=list[AdminUserOut])
async def list_users(
    me: Super,
    db: Db,
    q: str = Query("", max_length=100),
    filter: Literal["all", "blocked", "superusers"] = "all",
    before: datetime | None = None,
    limit: int = Query(50, ge=1, le=100),
):
    query = select(User)
    if q.strip():
        pattern = _like(q.strip())
        query = query.where(
            or_(
                User.username.ilike(pattern, escape="\\"),
                User.first_name.ilike(pattern, escape="\\"),
                User.last_name.ilike(pattern, escape="\\"),
                User.phone.ilike(pattern, escape="\\"),
            )
        )
    if filter == "blocked":
        query = query.where(User.blocked_at.is_not(None))
    elif filter == "superusers":
        query = query.where(User.is_superuser.is_(True))
    if before:
        query = query.where(User.created_at < before)
    rows = await db.execute(query.order_by(User.created_at.desc()).limit(limit))
    return [_user_out(u) for u in rows.scalars()]


async def _target(db: AsyncSession, user_id: str) -> User:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    return user


class BlockBody(BaseModel):
    reason: str = Field(default="", max_length=200)


@router.post("/users/{user_id}/block", response_model=AdminUserOut)
async def block_user(user_id: str, body: BlockBody, me: Super, db: Db):
    """Заблокировать на всём ресурсе: войти нельзя, открытые сессии закрываются, с Планет выводит."""
    user = await _target(db, user_id)
    if user.id == me.id:
        raise HTTPException(status_code=400, detail="Себя заблокировать нельзя")
    if user.is_superuser:
        raise HTTPException(status_code=400, detail="Сначала снимите с него роль владельца ресурса")
    user.blocked_at = _now()
    user.blocked_reason = " ".join(body.reason.split()) or None
    await db.commit()
    # Сессии: закрываем соединения; HTTP-запросы с его токеном дальше получают 401.
    for ws in list(manager.user_connections.get(user.id, [])):
        try:
            await ws.close(code=4001)
        except Exception:  # noqa: BLE001
            pass
    star_ids = (await db.execute(select(StarMember.star_id).where(StarMember.user_id == user.id))).scalars().all()
    for star_id in star_ids:
        await voice.evict_user(star_id, user.id)
    return _user_out(user)


@router.delete("/users/{user_id}/block", response_model=AdminUserOut)
async def unblock_user(user_id: str, me: Super, db: Db):
    user = await _target(db, user_id)
    user.blocked_at = None
    user.blocked_reason = None
    await db.commit()
    return _user_out(user)


@router.put("/users/{user_id}/superuser", response_model=AdminUserOut)
async def grant_superuser(user_id: str, me: Super, db: Db):
    user = await _target(db, user_id)
    if user.blocked_at:
        raise HTTPException(status_code=400, detail="Сначала разблокируйте пользователя")
    user.is_superuser = True
    await db.commit()
    return _user_out(user)


@router.delete("/users/{user_id}/superuser", response_model=AdminUserOut)
async def revoke_superuser(user_id: str, me: Super, db: Db):
    user = await _target(db, user_id)
    if user.is_superuser:
        others = (
            await db.execute(
                select(func.count()).select_from(User).where(User.is_superuser.is_(True), User.id != user.id)
            )
        ).scalar_one()
        if not others:
            raise HTTPException(status_code=400, detail="Это последний владелец ресурса — роль снять нельзя")
    user.is_superuser = False
    await db.commit()
    return _user_out(user)


# --- Звёзды ---------------------------------------------------------------------------


class AdminStarOut(BaseModel):
    id: str
    name: str
    kind: str
    owner_id: str
    owner_name: str | None
    member_count: int
    created_at: datetime
    i_am_member: bool


@router.get("/stars", response_model=list[AdminStarOut])
async def list_stars(
    me: Super,
    db: Db,
    q: str = Query("", max_length=100),
    limit: int = Query(100, ge=1, le=200),
):
    members = (
        select(StarMember.star_id, func.count().label("n")).group_by(StarMember.star_id).subquery()
    )
    mine = select(StarMember.star_id).where(StarMember.user_id == me.id)
    query = (
        select(Star, User.username, func.coalesce(members.c.n, 0))
        .outerjoin(User, User.id == Star.owner_id)
        .outerjoin(members, members.c.star_id == Star.id)
    )
    if q.strip():
        query = query.where(Star.name.ilike(_like(q.strip()), escape="\\"))
    my_ids = set((await db.execute(mine)).scalars().all())
    rows = await db.execute(query.order_by(Star.created_at.desc()).limit(limit))
    return [
        AdminStarOut(
            id=s.id, name=s.name, kind=s.kind, owner_id=s.owner_id, owner_name=owner, member_count=n,
            created_at=s.created_at, i_am_member=s.id in my_ids,
        )
        for s, owner, n in rows.all()
    ]


# --- Жалобы ---------------------------------------------------------------------------


class AdminReportOut(BaseModel):
    id: str
    reporter: AdminUserOut | None
    target: AdminUserOut | None
    reason: str
    comment: str | None
    evidence: list
    created_at: datetime
    resolved_at: datetime | None


@router.get("/reports", response_model=list[AdminReportOut])
async def list_reports(
    me: Super,
    db: Db,
    status_filter: Literal["open", "all"] = Query("open", alias="status"),
    limit: int = Query(100, ge=1, le=200),
):
    query = select(UserReport)
    if status_filter == "open":
        query = query.where(UserReport.resolved_at.is_(None))
    reports = (await db.execute(query.order_by(UserReport.created_at.desc()).limit(limit))).scalars().all()
    ids = {r.reporter_id for r in reports} | {r.target_id for r in reports}
    users = {u.id: _user_out(u) for u in (await db.execute(select(User).where(User.id.in_(ids - {None})))).scalars()}
    return [
        AdminReportOut(
            id=r.id, reporter=users.get(r.reporter_id), target=users.get(r.target_id), reason=r.reason,
            comment=r.comment, evidence=r.evidence or [], created_at=r.created_at, resolved_at=r.resolved_at,
        )
        for r in reports
    ]


@router.post("/reports/{report_id}/resolve", status_code=status.HTTP_204_NO_CONTENT)
async def resolve_report(report_id: str, me: Super, db: Db):
    result = await db.execute(
        update(UserReport)
        .where(UserReport.id == report_id, UserReport.resolved_at.is_(None))
        .values(resolved_at=_now(), resolved_by=me.id)
    )
    await db.commit()
    if not result.rowcount:
        raise HTTPException(status_code=404, detail="Жалоба не найдена или уже разобрана")
