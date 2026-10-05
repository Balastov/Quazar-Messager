#!/usr/bin/env bash
# Build deploy/coturn/turnserver.conf from .env.prod (never commit the output).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${1:-$ROOT/.env.prod}"
TEMPLATE="$ROOT/deploy/coturn/turnserver.conf.template"
OUT="$ROOT/deploy/coturn/turnserver.conf"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${WEBRTC_TURN_USERNAME:?Set WEBRTC_TURN_USERNAME in .env.prod}"
: "${WEBRTC_TURN_CREDENTIAL:?Set WEBRTC_TURN_CREDENTIAL in .env.prod}"
: "${TURN_EXTERNAL_IP:?Set TURN_EXTERNAL_IP (public IPv4 of the VM) in .env.prod}"

TURN_REALM="${TURN_REALM:-${DOMAIN:-quazar-msg.ru}}"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing template $TEMPLATE" >&2
  exit 1
fi

sed \
  -e "s|{{TURN_EXTERNAL_IP}}|${TURN_EXTERNAL_IP}|g" \
  -e "s|{{TURN_REALM}}|${TURN_REALM}|g" \
  -e "s|{{WEBRTC_TURN_USERNAME}}|${WEBRTC_TURN_USERNAME}|g" \
  -e "s|{{WEBRTC_TURN_CREDENTIAL}}|${WEBRTC_TURN_CREDENTIAL}|g" \
  "$TEMPLATE" > "$OUT"

chmod 600 "$OUT"
echo "Wrote $OUT"
