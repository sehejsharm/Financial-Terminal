#!/usr/bin/env bash
# Pull-based auto-deploy — the VM updates ITSELF, no SSH or CI secrets needed.
#
# Runs every few minutes via systemd timer (installed by
# install-autodeploy.sh). Checks origin for new commits on the deploy branch;
# when found, resets to them and rebuilds the containers. flock guarantees
# runs never overlap (a slow build just delays the next check).
#
# Log: /var/log/mb-autodeploy.log
set -u

REPO=/home/ubuntu/Financial-Terminal
BRANCH=claude/stock-market-dashboard-2BBMA
LOG=/var/log/mb-autodeploy.log

exec 9>/var/lock/mb-autodeploy.lock
flock -n 9 || exit 0

log() { echo "$(date -Is) $*" >>"$LOG"; }

# Git runs as the ubuntu user (repo owner); docker as root (we are root).
g() { sudo -u ubuntu git -C "$REPO" "$@"; }

g fetch origin "$BRANCH" --quiet || { log "fetch failed (network?) — will retry"; exit 0; }
LOCAL=$(g rev-parse HEAD)
REMOTE=$(g rev-parse "origin/$BRANCH")
# --force: rebuild even when already at origin (used by the installer for the
# first deploy, since the bootstrap has already reset the repo to origin).
if [ "$LOCAL" = "$REMOTE" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

log "new commit detected: $LOCAL -> $REMOTE — deploying"
g reset --hard "origin/$BRANCH" >>"$LOG" 2>&1

cd "$REPO/deploy"
if docker compose up -d --build >>"$LOG" 2>&1; then
  log "deploy OK at $REMOTE"
else
  log "deploy FAILED at $REMOTE — old containers keep running; will retry on next new commit"
fi
