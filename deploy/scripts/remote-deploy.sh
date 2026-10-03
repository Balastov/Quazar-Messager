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

echo "==> Status:"
docker compose -f docker-compose.prod.yml --env-file .env.prod ps

echo "==> Deploy finished."
