#!/usr/bin/env bash
# Переносит файлы пользователей и файлы обновлений Quazar с системного диска на HDD.
#
#   cd /opt/quazar && sudo bash deploy/scripts/move-media-to-hdd.sh
#
# Запускать после деплоя, в котором docker-compose.prod.yml понимает MEDIA_DIR.
# Повторный запуск безопасен: перенесённое пропускается. Старые данные не удаляются —
# в конце скрипт печатает, чем их убрать после проверки.
set -Eeuo pipefail

HDD=/srv/hdd
MEDIA_DST=$HDD/quazar/media
UPDATES_DST=$HDD/quazar/desktop-updates
UPDATES=/opt/quazar/desktop-updates
MARKER=.quazar-media

cd "$(dirname "$0")/../.."
compose=(docker compose -f docker-compose.prod.yml --env-file .env.prod)

[[ $EUID -eq 0 ]] || { echo "Запустите через sudo" >&2; exit 1; }
[[ -f .env.prod ]] || { echo "Нет .env.prod — запускайте из /opt/quazar" >&2; exit 1; }
mountpoint -q "$HDD" || { echo "$HDD не подключён — HDD не найден" >&2; exit 1; }
grep -q 'MEDIA_DIR' docker-compose.prod.yml || { echo "Сначала задеплойте версию с MEDIA_DIR" >&2; exit 1; }

media_source() {
  local id
  id="$("${compose[@]}" ps -q backend)"
  [[ -n "$id" ]] || return 0
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/media"}}{{.Source}}{{end}}{{end}}' "$id"
}

wait_ready() {
  for _ in {1..30}; do
    curl -fsS --max-time 5 http://127.0.0.1:8002/openapi.json >/dev/null && return 0
    sleep 2
  done
  return 1
}

# ---------- Docker ждёт HDD при загрузке ----------
# С nofail загрузка не ждёт диск, и Docker мог бы стартовать раньше и подключить пустой
# каталог на SSD. Wants, а не Requires: без HDD Docker и остальные сайты всё равно запустятся.
dropin=/etc/systemd/system/docker.service.d/quazar-hdd.conf
if [[ ! -f "$dropin" ]]; then
  mkdir -p "$(dirname "$dropin")"
  unit="$(systemd-escape -p --suffix=mount "$HDD")"
  printf '[Unit]\nWants=%s\nAfter=%s\n' "$unit" "$unit" > "$dropin"
  systemctl daemon-reload
  echo "==> Docker при загрузке ждёт $HDD"
fi

# ---------- Файлы пользователей: вложения, файлы Звёзд, аватары, стикеры ----------
src="$(media_source)"
if [[ "$src" == "$MEDIA_DST" ]]; then
  echo "==> Медиа уже на HDD: $MEDIA_DST"
else
  [[ -n "$src" && -d "$src" ]] || { echo "Не нашёл каталог медиа работающего backend" >&2; exit 1; }
  if [[ -e "$MEDIA_DST" && -n "$(ls -A "$MEDIA_DST")" ]]; then
    echo "$MEDIA_DST не пуст — разберитесь вручную, скрипт ничего не трогал" >&2; exit 1
  fi
  need=$(du -sk "$src" | cut -f1); free=$(df -k --output=avail "$HDD" | tail -1)
  (( free > need * 2 )) || { echo "На HDD мало места: нужно ${need} КБ, свободно ${free} КБ" >&2; exit 1; }

  echo "==> Медиа: $src ($(du -sh "$src" | cut -f1)) → $MEDIA_DST"
  cp -p .env.prod .env.prod.before-hdd
  restore() {
    echo "==> Ошибка — возвращаю прежнее хранилище" >&2
    cat .env.prod.before-hdd > .env.prod
    "${compose[@]}" up -d backend || true
    echo "Прежние файлы не тронуты. Перед повтором удалите неполную копию: rm -r $MEDIA_DST" >&2
  }
  trap restore ERR

  mkdir -p "$MEDIA_DST"
  echo "==> Останавливаю backend на время копирования (чаты недоступны около минуты)"
  "${compose[@]}" stop backend
  cp -a "$src/." "$MEDIA_DST/"
  diff -rq "$src" "$MEDIA_DST"
  touch "$MEDIA_DST/$MARKER"

  # Перезапись через > сохраняет владельца и права .env.prod.
  rest="$(grep -vE '^(MEDIA_DIR|MEDIA_MARKER)=' .env.prod.before-hdd || true)"
  printf '%s\n\n# Медиа на HDD (deploy/scripts/move-media-to-hdd.sh)\nMEDIA_DIR=%s\nMEDIA_MARKER=%s\n' \
    "$rest" "$MEDIA_DST" "$MARKER" > .env.prod

  "${compose[@]}" up -d backend
  wait_ready || { echo "backend не поднялся" >&2; false; }
  [[ "$(media_source)" == "$MEDIA_DST" ]] || { echo "backend смотрит не на HDD" >&2; false; }
  trap - ERR
  echo "==> Медиа на HDD, backend работает"
  old_media="$src"
fi

# ---------- Файлы обновлений ПК и Android ----------
if mountpoint -q "$UPDATES"; then
  echo "==> Файлы обновлений уже на HDD"
else
  echo "==> Обновления: $UPDATES ($(du -sh "$UPDATES" | cut -f1)) → $UPDATES_DST"
  mkdir -p "$UPDATES_DST"
  cp -a "$UPDATES/." "$UPDATES_DST/"
  diff -rq "$UPDATES" "$UPDATES_DST"
  chown --reference="$UPDATES" "$UPDATES_DST"
  chmod --reference="$UPDATES" "$UPDATES_DST"

  line="$UPDATES_DST $UPDATES none bind,nofail,x-systemd.requires-mounts-for=$HDD 0 0"
  if ! grep -qF "$line" /etc/fstab; then
    cp -p /etc/fstab /etc/fstab.before-quazar-hdd
    printf '%s\n' "$line" >> /etc/fstab
  fi
  # Старый каталог в сторону (под точкой подключения он бы продолжал занимать SSD).
  mv "$UPDATES" "$UPDATES.ssd-old"
  mkdir "$UPDATES"
  chown --reference="$UPDATES.ssd-old" "$UPDATES"
  systemctl daemon-reload
  if ! mount "$UPDATES" || ! mountpoint -q "$UPDATES"; then
    rmdir "$UPDATES" && mv "$UPDATES.ssd-old" "$UPDATES"
    echo "Не удалось подключить $UPDATES_DST — вернул прежний каталог" >&2; exit 1
  fi
  # Контейнер web держит прежний каталог — пересоздаём, чтобы он увидел HDD.
  "${compose[@]}" up -d --force-recreate --no-deps web
  echo "==> Обновления на HDD"
  old_updates="$UPDATES.ssd-old"
fi

echo
df -h / "$HDD"
echo
echo "Проверьте: картинки в старых чатах открываются, новая отправляется, файлы в Звёздах скачиваются."
echo "После проверки освободите SSD:"
if [[ "${old_media:-}" == /var/lib/docker/volumes/*/_data ]]; then
  echo "  docker volume rm $(basename "$(dirname "$old_media")")   # прежний том медиа"
fi
[[ -n "${old_updates:-}" ]] && echo "  rm -r $old_updates"
echo "  rm .env.prod.before-hdd"
exit 0
