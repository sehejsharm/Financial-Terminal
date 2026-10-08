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
# How long to wait for the new container to report healthy before treating the
# deploy as failed and rolling back. The compose healthcheck has a 60s
# start_period and a 30s interval, so this must comfortably exceed
# start_period + interval or a slow-but-fine boot gets rolled back.
HEALTH_TIMEOUT_SEC=180

exec 9>/var/lock/mb-autodeploy.lock
flock -n 9 || exit 0

log() { echo "$(date -Is) $*" >>"$LOG"; }

free_mb() { df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}'; }

# Git runs as the ubuntu user (repo owner); docker as root (we are root).
g() { sudo -u ubuntu git -C "$REPO" "$@"; }

# Docker's own verdict on the backend, which is the same signal the watchdog
# uses. Reusing it means there is one definition of "healthy" rather than a
# second probe here that could disagree with the one that triggers restarts.
health() {
  docker inspect --format '{{.State.Health.Status}}' \
    "$(docker compose ps -q backend 2>/dev/null)" 2>/dev/null || echo "missing"
}

# Bring up the stack and WAIT for it to actually answer.
#
# This is the part that was missing, and it is the difference between a deploy
# gate and a deploy hope: `docker compose up -d --build` exits 0 as soon as the
# container STARTS. A build that compiles and then dies on an import error, a
# bad env var or a failed migration satisfies it completely — the broken
# container replaces the working one and nothing notices. The watchdog does not
# save us either: restarting a genuinely broken image just loops.
bring_up() {
  docker compose up -d --build >>"$LOG" 2>&1 || return 1
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SEC" ]; do
    case "$(health)" in
      healthy) return 0 ;;
      # `unhealthy` is reported only after the healthcheck's retries are
      # exhausted, so it is already a settled verdict — no point waiting out
      # the rest of the timeout.
      unhealthy) log "backend reported unhealthy"; return 1 ;;
    esac
    sleep 5
    waited=$((waited + 5))
  done
  log "backend did not become healthy within ${HEALTH_TIMEOUT_SEC}s"
  return 1
}

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

# The commit we are leaving, captured BEFORE the reset so there is something
# to go back to. Without this the rollback below has no target.
PREVIOUS="$LOCAL"

g reset --hard "origin/$BRANCH" >>"$LOG" 2>&1

cd "$REPO/deploy"

# Stamp the running image with the commit it was built from, so /version
# reports what is actually deployed. It was hardcoded to "oracle-1", which
# meant that on a service redeploying every four minutes there was no way to
# tell which commit was live — including while diagnosing a bad one.
export APP_VERSION="$(g rev-parse --short HEAD)"

if bring_up; then
  log "deploy OK at $REMOTE (APP_VERSION=$APP_VERSION)"
  # Dangling images only (-f, not -af): keeps the tagged image currently in
  # use, drops the layers the rebuild just orphaned.
  docker image prune -f >>"$LOG" 2>&1
  docker builder prune -f --keep-storage 2GB >>"$LOG" 2>&1
  log "post-deploy cleanup done — $(free_mb)MB free"
else
  log "deploy FAILED at $REMOTE — rolling back to $PREVIOUS"
  g reset --hard "$PREVIOUS" >>"$LOG" 2>&1
  export APP_VERSION="$(g rev-parse --short HEAD)"
  if bring_up; then
    log "ROLLED BACK to $PREVIOUS (APP_VERSION=$APP_VERSION) — the bad commit is still on the branch and WILL be retried on the next new commit"
  else
    # Both the new and the previous commit failed to come up. That points at
    # the environment (disk, Docker, a provider the app needs at boot) rather
    # than at the code, so there is nothing further this script can do and
    # saying so is more useful than another retry.
    log "ROLLBACK ALSO FAILED — the previous commit will not start either, so this is environmental, not the commit. Manual intervention needed; see deploy/recover.sh"
  fi
  log "free space now: $(free_mb)MB"
fi
