#!/usr/bin/env bash
# Obtain / renew Let's Encrypt certificate for DOMAIN.
# Run from the project root on the server:
#   bash deploy/scripts/get-cert.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env.prod ]]; then
  echo "Missing .env.prod — copy from .env.prod.example first."
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env.prod
set +a

DOMAIN="${DOMAIN:-quazar-msg.ru}"
EMAIL="${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL in .env.prod}"

echo "Requesting certificate for ${DOMAIN} and www.${DOMAIN} ..."

docker compose -f docker-compose.prod.yml --env-file .env.prod --profile certs \
  run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  -d "www.${DOMAIN}"

echo "Restarting nginx to pick up Let's Encrypt cert..."
docker compose -f docker-compose.prod.yml --env-file .env.prod restart nginx

echo "Done. Open https://${DOMAIN}"
