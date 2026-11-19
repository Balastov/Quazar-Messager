"""Хранилище файлов пользователей (MEDIA_ROOT).

На проде медиа лежит на отдельном диске. Если он не подключился, на его месте пустой
каталог на системном диске — туда нельзя принимать файлы: они займут место БД и пропадут
из виду, когда диск вернётся. Метка в корне хранилища показывает, что диск на месте.
"""
from __future__ import annotations

import logging
from pathlib import Path

from app.core.config import settings

log = logging.getLogger(__name__)


def media_ready() -> bool:
    marker = settings.MEDIA_MARKER
    if not marker or (Path(settings.MEDIA_ROOT) / marker).is_file():
        return True
    log.error("Media storage %s has no %s marker — is the media disk mounted?", settings.MEDIA_ROOT, marker)
    return False
