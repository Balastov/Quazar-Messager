#!/usr/bin/env bash
# Run only in /opt/quazar-bitrix24/releases/<commit>; never use production env/volumes.
set -euo pipefail
pilot_root=/opt/quazar-bitrix24
[[ "$PWD" =~ ^/opt/quazar-bitrix24/releases/[0-9a-f]{40}$ ]] || exit 2
available_kb=$(df -Pk "$pilot_root" | awk 'NR==2 {print $4}')
(( available_kb > 2500000 )) || { echo 'Not enough disk space for pilot build' >&2; exit 1; }
if [[ ! -f "$pilot_root/.env" ]]; then
  umask 077
  python3 - "$pilot_root/.env" <<'PY'
import base64, os, secrets, sys
from pathlib import Path
values = {
    "POSTGRES_PASSWORD": secrets.token_hex(24),
    "JWT_SECRET": secrets.token_hex(48),
    "BITRIX24_TOKEN_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode(),
    "BITRIX24_CLIENT_ID": "", "BITRIX24_CLIENT_SECRET": "",
}
with Path(sys.argv[1]).open('x') as f:
    f.write(''.join(f'{key}={value}\n' for key, value in values.items()))
PY
fi
if [[ -f "$pilot_root/.next-credentials.json" ]]; then
  python3 - "$pilot_root" <<'PY'
import json, os, re, sys
from pathlib import Path
root = Path(sys.argv[1]); pending = root / '.next-credentials.json'
values = json.loads(pending.read_text())
if set(values) != {'BITRIX24_CLIENT_ID', 'BITRIX24_CLIENT_SECRET'}:
    raise SystemExit('Unexpected pilot credential fields')
if any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9_.+/=-]{1,1024}', v) for v in values.values()):
    raise SystemExit('Invalid pilot credentials')
env = dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line)
env.update(values)
tmp = root / '.env.next'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: f.write(''.join(f'{k}={v}\n' for k,v in env.items()))
tmp.replace(root/'.env'); pending.unlink()
PY
fi
compose=(docker compose -f docker-compose.bitrix24-pilot.yml --env-file "$pilot_root/.env")
"${compose[@]}" up -d --build
ready=false
for attempt in {1..30}; do
  if curl -fsS --max-time 3 http://127.0.0.1:18084/healthz >/dev/null &&
     "${compose[@]}" exec -T backend python -c 'import urllib.request; urllib.request.urlopen("http://localhost:8000/openapi.json", timeout=3)' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]] || { echo 'Pilot failed readiness check' >&2; exit 1; }
sudo -n python3 deploy/bitrix24/ensure-pilot-route.py
ln -sfn "$PWD" "$pilot_root/current"
"${compose[@]}" ps
curl -fsS --max-time 10 https://quazar-msg.ru/bitrix24-pilot/healthz
curl -fsS --max-time 10 https://quazar-msg.ru/ >/dev/null
