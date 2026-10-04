#!/usr/bin/env bash
# Deploy Quazar on the VM (shared-host layout).
# Called by GitHub Actions over SSH from /opt/quazar.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> Fetching main..."
git fetch origin main
git checkout main
git reset --hard origin/main

echo "==> Rebuilding containers..."
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo "==> Ensuring host nginx /media + 4m upload limit..."
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
    text = re.sub(r"client_max_body_size\s+\S+;", "client_max_body_size 4m;", text)
else:
    text = re.sub(
        r"(listen\s+443[^;]*;)",
        r"\1\n\n    client_max_body_size 4m;",
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

echo "==> Status:"
docker compose -f docker-compose.prod.yml --env-file .env.prod ps

echo "==> Deploy finished."
