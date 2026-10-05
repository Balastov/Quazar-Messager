#!/usr/bin/env bash
# Append WebRTC/TURN variables to .env.prod (run once on the server).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${1:-$ROOT/.env.prod}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Create $ENV_FILE first (copy from .env.prod.example)." >&2
  exit 1
fi

if grep -q '^WEBRTC_TURN_CREDENTIAL=' "$ENV_FILE" 2>/dev/null; then
  echo "TURN vars already present in $ENV_FILE — skip or edit manually."
  exit 0
fi

DOMAIN="$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- || echo quazar-msg.ru)"
USER="${WEBRTC_TURN_USERNAME:-quazar}"
PASS="$(openssl rand -hex 24)"

cat >> "$ENV_FILE" <<EOF

# --- WebRTC TURN (Part 1) — generated $(date -u +%Y-%m-%dT%H:%MZ) ---
TURN_EXTERNAL_IP=REPLACE_WITH_VM_PUBLIC_IPV4
TURN_REALM=${DOMAIN}
WEBRTC_STUN_URLS=stun:${DOMAIN}:3478,stun:stun.l.google.com:19302
WEBRTC_TURN_URLS=turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp
WEBRTC_TURN_USERNAME=${USER}
WEBRTC_TURN_CREDENTIAL=${PASS}
EOF

echo "Appended TURN block to $ENV_FILE"
echo "IMPORTANT: set TURN_EXTERNAL_IP to your VM public IPv4, then run:"
echo "  bash deploy/scripts/render-turn-config.sh"
echo "  docker compose -f docker-compose.prod.yml --env-file .env.prod --profile turn up -d"
