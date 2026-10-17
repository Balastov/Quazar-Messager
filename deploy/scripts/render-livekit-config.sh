#!/usr/bin/env bash
# Готовит LiveKit (голос на Планетах) на сервере:
#   1. один раз генерирует LIVEKIT_API_KEY / LIVEKIT_API_SECRET в .env.prod (существующие не трогает);
#   2. собирает deploy/livekit/livekit.yaml из шаблона (файл с секретом, в git не попадает).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${1:-$ROOT/.env.prod}"
TEMPLATE="$ROOT/deploy/livekit/livekit.yaml.template"
OUT="$ROOT/deploy/livekit/livekit.yaml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

append_env() {
  if [[ -w "$ENV_FILE" ]]; then
    printf '%s\n' "$1" >> "$ENV_FILE"
  else
    printf '%s\n' "$1" | sudo tee -a "$ENV_FILE" > /dev/null
  fi
}

if ! grep -qE '^LIVEKIT_API_KEY=.+' "$ENV_FILE" || ! grep -qE '^LIVEKIT_API_SECRET=.+' "$ENV_FILE"; then
  echo "==> Generating LiveKit API key/secret in $(basename "$ENV_FILE")"
  append_env ""
  append_env "# LiveKit (голос на Планетах) — сгенерировано deploy/scripts/render-livekit-config.sh. Не менять."
  append_env "LIVEKIT_API_KEY=API$(openssl rand -hex 6)"
  append_env "LIVEKIT_API_SECRET=$(openssl rand -hex 24)"
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${LIVEKIT_API_KEY:?}"
: "${LIVEKIT_API_SECRET:?}"

# Конфиг собираем на Python: значения берутся из окружения и экранируются для YAML
# (строки JSON — валидные строки YAML), поэтому спецсимволы в паролях ничего не ломают.
python3 - "$TEMPLATE" "$OUT" <<'PY'
import json
import os
import sys

template, out = sys.argv[1], sys.argv[2]
env = os.environ
q = json.dumps

# Публичный IP сервера уже известен из настройки TURN; иначе LiveKit определит его сам.
ip = env.get("TURN_EXTERNAL_IP", "").strip()
node_ip = f"  use_external_ip: false\n  node_ip: {q(ip)}" if ip else "  use_external_ip: true"

# Ретранслятор для клиентов за строгим NAT — существующий coturn.
turn = ""
user, cred = env.get("WEBRTC_TURN_USERNAME", ""), env.get("WEBRTC_TURN_CREDENTIAL", "")
if user and cred:
    host = env.get("TURN_REALM") or env.get("DOMAIN") or "quazar-msg.ru"
    entries = []
    for proto in ("udp", "tcp"):
        entries.append(
            f"    - host: {q(host)}\n      port: 3478\n      protocol: {proto}\n"
            f"      username: {q(user)}\n      credential: {q(cred)}"
        )
    turn = "  turn_servers:\n" + "\n".join(entries)

text = open(template).read()
for key, value in {
    "{{NODE_IP_BLOCK}}": node_ip,
    "{{TURN_BLOCK}}": turn,
    "{{LIVEKIT_API_KEY}}": q(env["LIVEKIT_API_KEY"]),
    "{{LIVEKIT_API_SECRET}}": q(env["LIVEKIT_API_SECRET"]),
}.items():
    text = text.replace(key, value)
open(out, "w").write(text)
PY

chmod 600 "$OUT"
echo "Wrote $OUT"
