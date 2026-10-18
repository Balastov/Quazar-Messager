"""Стикерпаки: каталог для клиентов и сами анимации."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from starlette.staticfiles import StaticFiles

from app.core import stickers
from app.core.deps import get_current_user
from app.models.user import User

router = APIRouter(prefix="/stickers", tags=["stickers"])

FILES_PATH = "/stickers/files"


class StickerOut(BaseModel):
    id: str
    emoji: str
    # Путь от корня API: клиент добавляет свой адрес API (/api в вебе).
    url: str


class StickerPackOut(BaseModel):
    id: str
    version: int
    title: str
    author: str
    license: str
    license_url: str
    source_url: str
    stickers: list[StickerOut]


def pack_out(pack: stickers.StickerPack) -> StickerPackOut:
    return StickerPackOut(
        id=pack.id,
        version=pack.version,
        title=pack.title,
        author=pack.author,
        license=pack.license,
        license_url=pack.license_url,
        source_url=pack.source_url,
        stickers=[
            StickerOut(
                id=s.id,
                emoji=s.emoji,
                # Версия в адресе: файлы кэшируются навсегда, новая версия пака — новые адреса.
                url=f"{FILES_PATH}/{pack.id}/{s.file}?v={pack.version}",
            )
            for s in pack.stickers
        ],
    )


@router.get("/packs", response_model=list[StickerPackOut])
async def my_packs(current_user: Annotated[User, Depends(get_current_user)]):
    return [pack_out(p) for p in stickers.packs_for_user(current_user.id)]


class StickerFiles(StaticFiles):
    """Анимации стикеров: неизменяемые файлы, браузер и CDN держат их в кэше."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
