from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Point(BaseModel):
    x: float = Field(ge=0, le=1200, allow_inf_nan=False)
    y: float = Field(ge=0, le=700, allow_inf_nan=False)


class BoardItemBody(BaseModel):
    revision: int = Field(default=0, ge=0)
    kind: Literal["stroke", "note", "card"]
    color: Literal["green", "purple", "amber", "pink", "blue", "white"] = "green"
    points: list[Point] = Field(default_factory=list, max_length=500)
    width: int = Field(default=3, ge=1, le=12)
    x: float = Field(default=40, ge=0, le=1000, allow_inf_nan=False)
    y: float = Field(default=40, ge=0, le=580, allow_inf_nan=False)
    text: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def content(self):
        if self.kind == "stroke" and len(self.points) < 2:
            raise ValueError("Линия должна содержать хотя бы две точки")
        if self.kind != "stroke" and not self.text.strip():
            raise ValueError("Напишите текст карточки")
        return self


class FocusAction(BaseModel):
    action: Literal["start", "pause", "resume", "stop", "break"]
    version: int = Field(default=0, ge=0)
    work_minutes: int = Field(default=25, ge=1, le=180)
    break_minutes: int = Field(default=5, ge=1, le=60)


class VideoAction(BaseModel):
    action: Literal["select", "play", "pause", "seek", "share", "next", "stop"]
    version: int = Field(default=0, ge=0)
    file_id: str | None = Field(default=None, max_length=36)
    position: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    duration: float | None = Field(default=None, gt=0, le=86400, allow_inf_nan=False)
    shared_controls: bool = False


class PointersBody(BaseModel):
    enabled: bool


class PointerBody(BaseModel):
    star_id: str = Field(min_length=1, max_length=36)
    channel_id: str = Field(min_length=1, max_length=36)
    sharer_id: str = Field(min_length=1, max_length=36)
    x: float = Field(ge=0, le=1, strict=True, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, strict=True, allow_inf_nan=False)
