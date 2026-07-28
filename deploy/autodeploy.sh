#!/usr/bin/env bash
# Pull-based auto-deploy — the VM updates ITSELF, no SSH or CI secrets needed.
#
# Runs every few minutes via systemd timer (installed by
# install-autodeploy.sh). Checks origin for new commits on the deploy branch;
# when found, resets to them and rebuilds the containers. flock guarantees
# runs never overlap (a slow build just delays the next check).
#
# DISK: every deploy builds a new image, and the old one becomes dangling.
# Without pruning those accumulate until the boot volume fills — at which
# point the backend can no longer write data/ and login breaks. So each run
# reports free space, prunes after a successful deploy, and prunes hard
# BEFORE building if space is already tight.
#
# Log: /var/log/mb-autodeploy.log
set -u

REPO=/home/ubuntu/Financial-Terminal
BRANCH=claude/stock-market-dashboard-2BBMA
LOG=/var/log/mb-autodeploy.log
# Below this, a build is likely to fail or fill the disk — prune first.
MIN_FREE_MB=4096

exec 9>/var/lock/mb-autodeploy.lock
flock -n 9 || exit 0

log() { echo "$(date -Is) $*" >>"$LOG"; }

free_mb() { df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}'; }

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

FREE=$(free_mb)
log "new commit detected: $LOCAL -> $REMOTE — deploying (free: ${FREE:-?}MB)"

# Reclaim before building when space is short. Ordered least- to most-
# destructive; none of these touch running containers, their volumes, or
# data/ — only build cache and images nothing is using.
if [ -n "${FREE:-}" ] && [ "$FREE" -lt "$MIN_FREE_MB" ]; then
  log "low disk (${FREE}MB < ${MIN_FREE_MB}MB) — pruning before build"
  docker builder prune -af >>"$LOG" 2>&1
  docker image prune -af >>"$LOG" 2>&1
  log "after pre-build prune: $(free_mb)MB free"
fi

g reset --hard "origin/$BRANCH" >>"$LOG" 2>&1

cd "$REPO/deploy"
if docker compose up -d --build >>"$LOG" 2>&1; then
  log "deploy OK at $REMOTE"
  # Dangling images only (-f, not -af): keeps the tagged image currently in
  # use, drops the layers the rebuild just orphaned.
  docker image prune -f >>"$LOG" 2>&1
  docker builder prune -f --keep-storage 2GB >>"$LOG" 2>&1
  log "post-deploy cleanup done — $(free_mb)MB free"
else
  log "deploy FAILED at $REMOTE — old containers keep running; will retry on next new commit"
  log "free space now: $(free_mb)MB"
fi
