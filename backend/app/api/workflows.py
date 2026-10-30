"""Сценарии Звёзд: настройка (право «Каналы»), формы для участников, запуск вручную.

Триггеры и публикация — app/core/workflows.py; расписание срабатывает в app/core/scheduler.py.
"""

import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _load_membership, _require_perm, assert_can_post, assert_clean_text
from app.core import star_audit, workflows
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import StarChannel, StarWorkflow
from app.models.user import User

router = APIRouter(prefix="/stars", tags=["workflows"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

MAX_WORKFLOWS = 30
MAX_FIELD_VALUE = 1000
FORM_RATE = 10  # отправок формы в минуту на человека
_recent: dict[str, deque[float]] = defaultdict(deque)

Trigger = Literal["member_joined", "schedule", "form"]


class Schedule(BaseModel):
    # Дни недели: 1 — понедельник … 7 — воскресенье.
    days: list[int] = Field(min_length=1, max_length=7)
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    tz: str = workflows.DEFAULT_TZ

    @field_validator("days")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 1 or d > 7 for d in v):
            raise ValueError("Дни недели — от 1 (пн) до 7 (вс)")
        return sorted(set(v))

    @field_validator("tz")
    @classmethod
    def _tz(cls, v: str) -> str:
        if workflows.zone(v).key != v:
            raise ValueError("Неизвестный часовой пояс")
        return v


class FormField(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_]{1,32}$")
    label: str = Field(min_length=1, max_length=60)
    kind: Literal["text", "textarea", "select"] = "text"
    required: bool = True
    options: list[str] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def _options(self) -> "FormField":
        self.options = [o.strip()[:60] for o in self.options if o.strip()]
        if self.kind == "select" and len(self.options) < 2:
            raise ValueError(f"У списка «{self.label}» нужно хотя бы два варианта")
        return self


class WorkflowBody(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    enabled: bool = True
    trigger: Trigger
    schedule: Schedule | None = None
    form: list[FormField] | None = Field(default=None, max_length=10)
    channel_id: str
    # Для формы можно оставить пустым — карточка соберётся из полей сама.
    text: str = Field(default="", max_length=rules.MAX_MESSAGE_LENGTH)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Пустое название")
        return v

    @model_validator(mode="after")
    def _by_trigger(self) -> "WorkflowBody":
        if self.trigger == "schedule" and not self.schedule:
            raise ValueError("Укажите дни и время")
        if self.trigger == "form":
            if not self.form:
                raise ValueError("Добавьте в форму хотя бы одно поле")
            if len({f.id for f in self.form}) != len(self.form):
                raise ValueError("У полей формы должны быть разные id")
        elif not self.text.strip():
            raise ValueError("Напишите текст сообщения")
        if self.trigger != "schedule":
            self.schedule = None
        if self.trigger != "form":
            self.form = None
        return self


class WorkflowOut(BaseModel):
    id: str
    name: str
    enabled: bool
    trigger: Trigger
    schedule: Schedule | None
    form: list[FormField] | None
    channel_id: str
    text: str
    next_run_at: datetime | None
    last_run_at: datetime | None

    model_config = {"from_attributes": True}


class FormOut(BaseModel):
    """Форма для участников: что заполнить и куда уйдёт карточка."""

    id: str
    name: str
    channel_id: str
    fields: list[FormField]


class RunForm(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


async def _target_channel(db: AsyncSession, star_id: str, channel_id: str) -> StarChannel:
    channel = (
        await db.execute(
            select(StarChannel).where(
                StarChannel.id == channel_id, StarChannel.star_id == star_id, StarChannel.kind == "satellite"
            )
        )
    ).scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=422, detail="Выберите Спутник этой Звезды")
    return channel


async def _workflow(db: AsyncSession, star_id: str, workflow_id: str) -> StarWorkflow:
    wf = (
        await db.execute(select(StarWorkflow).where(StarWorkflow.id == workflow_id, StarWorkflow.star_id == star_id))
    ).scalar_one_or_none()
    if not wf:
        raise HTTPException(status_code=404, detail="Сценарий не найден")
    return wf


def _apply(wf: StarWorkflow, body: WorkflowBody) -> None:
    wf.name = body.name
    wf.enabled = body.enabled
    wf.trigger = body.trigger
    wf.schedule = body.schedule.model_dump() if body.schedule else None
    wf.form = [f.model_dump() for f in body.form] if body.form else None
    wf.channel_id = body.channel_id
    wf.text = body.text
    wf.next_run_at = (
        workflows.next_run(wf.schedule, datetime.now(timezone.utc)) if wf.trigger == "schedule" and wf.enabled else None
    )


@router.get("/{star_id}/workflows", response_model=list[WorkflowOut])
async def list_workflows(star_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    rows = await db.execute(select(StarWorkflow).where(StarWorkflow.star_id == star_id).order_by(StarWorkflow.created_at))
    return [WorkflowOut.model_validate(w) for w in rows.scalars()]


@router.post("/{star_id}/workflows", response_model=WorkflowOut, status_code=status.HTTP_201_CREATED)
async def create_workflow(star_id: str, body: WorkflowBody, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    await _target_channel(db, star_id, body.channel_id)
    count = (
        await db.execute(select(func.count()).select_from(StarWorkflow).where(StarWorkflow.star_id == star_id))
    ).scalar_one()
    if count >= MAX_WORKFLOWS:
        raise HTTPException(status_code=409, detail=f"Не больше {MAX_WORKFLOWS} сценариев в Звезде")
    wf = StarWorkflow(star_id=star_id, created_by=current_user.id)
    _apply(wf, body)
    db.add(wf)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "workflow", wf.id, op="create", name=wf.name)
    return WorkflowOut.model_validate(wf)


@router.put("/{star_id}/workflows/{workflow_id}", response_model=WorkflowOut)
async def update_workflow(star_id: str, workflow_id: str, body: WorkflowBody, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    wf = await _workflow(db, star_id, workflow_id)
    await _target_channel(db, star_id, body.channel_id)
    _apply(wf, body)
    await db.commit()
    return WorkflowOut.model_validate(wf)


@router.delete("/{star_id}/workflows/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(star_id: str, workflow_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    wf = await _workflow(db, star_id, workflow_id)
    name = wf.name
    await db.delete(wf)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "workflow", workflow_id, op="delete", name=name)


@router.post("/{star_id}/workflows/{workflow_id}/test", status_code=status.HTTP_204_NO_CONTENT)
async def test_workflow(star_id: str, workflow_id: str, current_user: CurrentUser, db: Db):
    """Проверить сообщение сейчас: для «новый участник» — как будто пришёл тот, кто нажал."""
    star, _ = await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    wf = await _workflow(db, star_id, workflow_id)
    if wf.trigger == "form":
        raise HTTPException(status_code=422, detail="Форму проверьте, отправив её из Спутника")
    tz = (wf.schedule or {}).get("tz")
    await workflows.post(db, wf, workflows.render(wf.text, workflows.base_values(star, tz, current_user)))


@router.get("/{star_id}/forms", response_model=list[FormOut])
async def list_forms(star_id: str, current_user: CurrentUser, db: Db):
    """Формы Звезды для участников (меню «+» в Спутнике)."""
    await _load_membership(db, star_id, current_user.id)
    rows = await db.execute(
        select(StarWorkflow)
        .where(StarWorkflow.star_id == star_id, StarWorkflow.trigger == "form", StarWorkflow.enabled.is_(True))
        .order_by(StarWorkflow.name)
    )
    return [
        FormOut(id=w.id, name=w.name, channel_id=w.channel_id, fields=[FormField(**f) for f in w.form or []])
        for w in rows.scalars()
    ]


def _rate(user_id: str) -> None:
    now = time.monotonic()
    recent = _recent[user_id]
    while recent and now - recent[0] > 60:
        recent.popleft()
    if len(recent) >= FORM_RATE:
        raise HTTPException(status_code=429, detail="Слишком часто — попробуйте через минуту")
    recent.append(now)


@router.post("/{star_id}/forms/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def submit_form(star_id: str, workflow_id: str, body: RunForm, current_user: CurrentUser, db: Db):
    """Заполненная форма → карточка в Спутник сценария."""
    star, me = await _load_membership(db, star_id, current_user.id)
    assert_can_post(star, me)
    wf = await _workflow(db, star_id, workflow_id)
    if wf.trigger != "form" or not wf.enabled:
        raise HTTPException(status_code=404, detail="Форма не найдена")
    _rate(current_user.id)
    fields = [FormField(**f) for f in wf.form or []]
    values: dict[str, str] = {}
    for field in fields:
        value = " ".join(body.values.get(field.id, "").split()) if field.kind != "textarea" else body.values.get(field.id, "").strip()
        value = value[:MAX_FIELD_VALUE]
        if field.required and not value:
            raise HTTPException(status_code=422, detail=f"Заполните «{field.label}»")
        if field.kind == "select" and value and value not in field.options:
            raise HTTPException(status_code=422, detail=f"Выберите вариант из списка «{field.label}»")
        values[field.id] = value
    assert_clean_text(star, me, " ".join(values.values()))
    base = workflows.base_values(star, None, current_user)
    if wf.text.strip():
        text = workflows.render(wf.text, {**base, **values})
    else:
        lines = [f"📝 **{wf.name}** от {base['user']}", ""]
        for field in fields:
            if values.get(field.id):
                sep = "\n" if field.kind == "textarea" else " "
                lines.append(f"**{field.label}:**{sep}{values[field.id]}")
        text = "\n".join(lines)
    await workflows.post(db, wf, text, not_mention=current_user.id)
