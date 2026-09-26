#!/usr/bin/env bash
# Install Quazar into system nginx on a shared VM (padma / mispring stay intact).
# Run from /opt/quazar as a user with sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "Stopping Docker edge nginx if running (must not bind 80/443)..."
docker compose -f docker-compose.prod.yml --env-file .env.prod stop nginx 2>/dev/null || true
docker compose -f docker-compose.prod.yml --env-file .env.prod rm -f nginx 2>/dev/null || true

echo "Ensuring system nginx is running..."
sudo systemctl enable nginx
sudo systemctl start nginx

echo "Starting Quazar app containers (localhost ports only)..."
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo "Installing HTTP-only site (bootstrap)..."
sudo cp deploy/host-nginx/quazar-msg.ru.http-only.conf /etc/nginx/sites-available/quazar-msg.ru
sudo ln -sf /etc/nginx/sites-available/quazar-msg.ru /etc/nginx/sites-enabled/quazar-msg.ru
sudo nginx -t
sudo systemctl reload nginx

echo "Requesting Let's Encrypt certificate via certbot nginx plugin..."
if ! command -v certbot >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y certbot python3-certbot-nginx
fi

# shellcheck disable=SC1091
set -a
source .env.prod
set +a
EMAIL="${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL in .env.prod}"

sudo certbot --nginx -d quazar-msg.ru -d www.quazar-msg.ru \
  --email "$EMAIL" --agree-tos --no-eff-email --redirect --non-interactive \
  || sudo certbot --nginx -d quazar-msg.ru -d www.quazar-msg.ru \
  --email "$EMAIL" --agree-tos --no-eff-email --redirect

echo "Done."
echo "Check: https://quazar-msg.ru  https://padma.ru  https://mispring.ru"
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
