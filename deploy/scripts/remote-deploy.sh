#!/usr/bin/env bash
# Deploy Quazar on the VM (shared-host layout).
# Called by GitHub Actions over SSH from /opt/quazar.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> Fetching main..."
git fetch origin main
git checkout main
git reset --hard origin/main

echo "==> Validating user-facing release notes..."
python3 deploy/scripts/validate-release-notes.py

COMPOSE_PROFILES=()
if [[ -f .env.prod ]] \
  && grep -qE '^WEBRTC_TURN_CREDENTIAL=.+' .env.prod \
  && grep -qE '^TURN_EXTERNAL_IP=[0-9.]+' .env.prod; then
  echo "==> TURN configured — enabling coturn profile"
  bash deploy/scripts/render-turn-config.sh .env.prod
  COMPOSE_PROFILES=(--profile turn)
elif [[ -f .env.prod ]] && grep -qE '^WEBRTC_TURN_CREDENTIAL=.+' .env.prod; then
  echo "==> WARN: WEBRTC_TURN_CREDENTIAL set but TURN_EXTERNAL_IP missing — coturn not started (see docs/WEBRTC-TURN.md)"
fi

# Голос на Планетах: ключи и конфиг LiveKit. Если не вышло — сайт деплоится без голоса.
if [[ -f .env.prod ]]; then
  if bash deploy/scripts/render-livekit-config.sh .env.prod; then
    echo "==> LiveKit configured — enabling voice profile"
    COMPOSE_PROFILES+=(--profile voice)
  else
    echo "==> WARN: LiveKit config failed — voice on Planets stays off (see docs/VOICE-PLANETS.md)"
  fi
fi

env_value() {
  [[ -f .env.prod ]] || return 0
  { grep -E "^$1=" .env.prod || true; } | tail -1 | cut -d= -f2- | tr -d "\"'"
}

# Медиа на HDD: если диск не подключился, на месте каталога пусто — не запускаемся поверх него.
media_dir="$(env_value MEDIA_DIR)"
media_marker="$(env_value MEDIA_MARKER)"
if [[ -n "$media_dir" ]]; then
  if [[ -z "$media_marker" || ! -f "$media_dir/$media_marker" ]]; then
    echo "==> ERROR: $media_dir has no ${media_marker:-MEDIA_MARKER} marker — is the media disk mounted? Deploy stopped." >&2
    exit 1
  fi
  echo "==> Media storage: $media_dir ($(df -h --output=avail "$media_dir" | tail -1 | tr -d ' ') free)"
fi
if grep -qE '^[^#]*[[:space:]]/opt/quazar/desktop-updates[[:space:]]' /etc/fstab && ! mountpoint -q /opt/quazar/desktop-updates; then
  echo "==> WARN: /opt/quazar/desktop-updates is not mounted from the HDD — update files may be missing" >&2
fi

echo "==> Rebuilding containers..."
mkdir -p desktop-updates
sudo python3 deploy/scripts/ensure-desktop-updates-nginx.py
docker compose -f docker-compose.prod.yml --env-file .env.prod "${COMPOSE_PROFILES[@]}" up -d --build

# Каждая сборка оставляет прежние образы и кэш — без уборки они заполняют системный диск.
echo "==> Removing unused images and old build cache..."
docker image prune -f >/dev/null || true
docker builder prune -f --filter until=168h >/dev/null || true
# Установщики и обновления: текущий выпуск и предыдущий, остальное удаляется сразу.
python3 .github/scripts/publish-desktop-updates.py --prune \
  || echo "==> WARN: could not remove old app releases from desktop-updates" >&2
df -h --output=avail,pcent / | tail -1 | awk '{print "==> System disk: " $1 " free (" $2 " used)"}'

echo "==> Ensuring host nginx /media, /livekit/ + 12m upload limit (10 MB chat images)..."
SITE=/etc/nginx/sites-available/quazar-msg.ru
if [[ -f "$SITE" ]]; then
  sudo python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

path = Path("/etc/nginx/sites-available/quazar-msg.ru")
text = path.read_text()
orig = text

if re.search(r"client_max_body_size\s+\S+;", text):
    text = re.sub(r"client_max_body_size\s+\S+;", "client_max_body_size 52m;", text)
else:
    text = re.sub(
        r"(listen\s+443[^;]*;)",
        r"\1\n\n    client_max_body_size 52m;",
        text,
        count=1,
    )

MEDIA = """
    location /media/ {
        proxy_pass http://127.0.0.1:8002/media/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        expires 7d;
        add_header Cache-Control "public";
    }
"""
if "location /media/" not in text:
    if "location /ws" in text:
        text = text.replace("location /ws", MEDIA + "\n    location /ws", 1)
    else:
        text = text.replace("location / {", MEDIA + "\n    location / {", 1)

LIVEKIT = """
    location /livekit/ {
        proxy_pass http://127.0.0.1:7880/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
"""
if "location /livekit/" not in text:
    # Вставляем в HTTPS-блок: рядом с /ws. Первый "location / {" — это редирект в HTTP-блоке.
    if "location /ws" in text:
        text = text.replace("location /ws", LIVEKIT.strip() + "\n\n    location /ws", 1)
    else:
        head, sep, tail = text.rpartition("location / {")
        text = head + LIVEKIT.strip() + "\n\n    " + sep + tail

if text != orig:
    path.write_text(text)
    check = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if check.returncode != 0:
        path.write_text(orig)
        print(check.stderr, file=sys.stderr)
        sys.exit(check.returncode)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("nginx updated")
else:
    print("nginx already OK")
PY
fi

echo "==> Waiting for the deployed API and web..."
ready=false
for attempt in {1..30}; do
  if curl -fsS --max-time 5 http://127.0.0.1:8002/openapi.json >/dev/null \
    && curl -fsS --max-time 5 http://127.0.0.1:3080/ >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  echo "Deployment did not become ready; release news will not be saved." >&2
  exit 1
fi

echo "==> Saving the release news draft for approval in the Black Hole..."
release_version=$(python3 -c 'import json; print(json.load(open("web/package.json"))["version"])')
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend \
  python -m app.release_news --expected-version "$release_version" < deploy/release-notes.json

echo "==> Status:"
docker compose -f docker-compose.prod.yml --env-file .env.prod "${COMPOSE_PROFILES[@]}" ps

echo "==> Deploy finished."
