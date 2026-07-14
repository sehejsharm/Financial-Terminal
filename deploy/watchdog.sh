#!/usr/bin/env bash
# Auto-heal: restart the backend container when Docker marks it unhealthy.
#
# The backend's compose healthcheck probes /healthz every 30s (3 retries), so
# "unhealthy" already means ~90s of consecutive failures — a hung or deadlocked
# process, not a blip. `restart: unless-stopped` covers crashes; this covers
# hangs, which Docker's restart policy does NOT act on by itself.
#
# Installed by setup.sh as /etc/cron.d/motherboard-watchdog (runs every 2 min).
set -u
cd "$(dirname "$0")"

NAME="deploy-backend-1"
STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo "missing")

if [[ "$STATUS" == "unhealthy" ]]; then
  echo "$(date -Is) backend unhealthy -> restarting"
  docker compose restart backend
elif [[ "$STATUS" == "missing" ]]; then
  echo "$(date -Is) backend container missing -> compose up"
  docker compose up -d backend
fi
