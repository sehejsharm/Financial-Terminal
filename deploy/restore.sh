#!/usr/bin/env bash
# Restore the backend data directory from a snapshot taken by deploy/backup.sh.
#
# WHY THIS EXISTS, SEPARATELY FROM recover.sh: recover.sh is a REPAIR tool. It
# prunes Docker, restarts the stack, and swaps in the atomic writer's `.bak`
# sibling when users.json is corrupt. Every one of those moves needs the data
# directory to still be there. This script is for when it is not — a lost
# volume, a deleted directory, a restore onto a fresh VM.
#
#   Verify a snapshot without restoring:  bash deploy/restore.sh --latest --verify-only
#   See what a restore would do:          bash deploy/restore.sh --latest --dry-run
#   Actually restore:                     sudo bash deploy/restore.sh --latest
#   From a specific archive:              sudo bash deploy/restore.sh /path/mb-data-….tar.gz
#
# IT NEVER DELETES THE DATA IT REPLACES. The existing directory is moved aside
# to data.pre-restore-<stamp>, so a restore from the wrong snapshot is itself
# recoverable and the two can be diffed afterwards. Clean those up by hand once
# you are satisfied — nothing here does it for you, on purpose.
#
# Runs against a scratch directory (MB_DATA_DIR) with no Docker, which is how
# the round trip is tested.
set -u

DATA_DIR=${MB_DATA_DIR:-/home/ubuntu/Financial-Terminal/deploy/data}
BACKUP_DIR=${MB_BACKUP_DIR:-/var/backups/motherboard}
LOG=${MB_BACKUP_LOG:-/var/log/mb-backup.log}
PREFIX=mb-data

# Kept because the arg loop below consumes $@, and one of the refusal messages
# needs to print the command the operator just ran.
ORIG_ARGS="$*"

ARCHIVE=""
ASSUME_YES=false
DRY_RUN=false
VERIFY_ONLY=false
FORCE=false
SKIP_CHECKSUM=false

log() {
  local line="$(date -Is) restore: $*"
  echo "$line"
  { echo "$line" >>"$LOG"; } 2>/dev/null || true
}
die() { log "ABORT: $*"; exit 1; }
have_python() { command -v python3 >/dev/null 2>&1; }

usage() {
  cat <<'TXT'
Usage: restore.sh (--latest | <archive.tar.gz>) [options]

  --latest          Use the newest snapshot in the backup dir.
  --verify-only     Check the archive and its payload; touch nothing. Run this
                    on a schedule — an untested backup is a belief.
  --dry-run         Verify, then report exactly what the restore would move.
  --yes             Do not prompt for confirmation (for scripted/timer use).
  --force           Proceed despite a refusal: a payload containing invalid
                    JSON, a missing checksum file, or a running backend.
  --skip-checksum   Restore without a .sha256 beside the archive. Last resort.
  --help

Environment:
  MB_DATA_DIR     directory to restore INTO   (default /home/ubuntu/Financial-Terminal/deploy/data)
  MB_BACKUP_DIR  where snapshots live        (default /var/backups/motherboard)
TXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    --latest)        ARCHIVE=LATEST ;;
    --yes|-y)        ASSUME_YES=true ;;
    --dry-run)       DRY_RUN=true ;;
    --verify-only)   VERIFY_ONLY=true ;;
    --force)         FORCE=true ;;
    --skip-checksum) SKIP_CHECKSUM=true ;;
    --help|-h)       usage; exit 0 ;;
    -*)              usage; exit 1 ;;
    *)               ARCHIVE="$1" ;;
  esac
  shift
done

[ -n "$ARCHIVE" ] || { usage; exit 1; }

# ── 1. pick the archive ─────────────────────────────────────────────────────
if [ "$ARCHIVE" = LATEST ]; then
  # Stamps are UTC and fixed-width, so a lexicographic sort is chronological.
  ARCHIVE=$(ls -1 "$BACKUP_DIR/$PREFIX-"*.tar.gz 2>/dev/null | LC_ALL=C sort | tail -1)
  [ -n "$ARCHIVE" ] || die "no snapshots found in $BACKUP_DIR — there is nothing to restore from. If the backups were off-host, fetch one and pass its path."
fi
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
ARCHIVE=$(readlink -m "$ARCHIVE")
log "archive: $ARCHIVE"

# ── 2. checksum ─────────────────────────────────────────────────────────────
# Checked before anything is extracted. A snapshot that came back from
# off-host storage is exactly where silent truncation shows up, and restoring
# a truncated archive over live data would turn a recoverable incident into an
# unrecoverable one.
if [ -f "$ARCHIVE.sha256" ]; then
  if ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" >/dev/null 2>&1 ); then
    log "checksum OK"
  else
    die "CHECKSUM MISMATCH — $(basename "$ARCHIVE") is not the file that was backed up (truncated or corrupted). Not restoring. Try an older snapshot, or re-fetch this one from off-host storage."
  fi
elif [ "$SKIP_CHECKSUM" = true ] || [ "$FORCE" = true ]; then
  log "WARNING: no checksum file beside the archive; proceeding because you asked"
else
  die "no $(basename "$ARCHIVE").sha256 beside the archive, so the archive cannot be verified. Re-run with --skip-checksum if you accept that."
fi

# ── 3. what does the manifest say about this snapshot? ──────────────────────
MANIFEST="${ARCHIVE%.tar.gz}.manifest.json"
if [ -f "$MANIFEST" ]; then
  log "manifest:"
  sed 's/^/    /' "$MANIFEST"
  if grep -q '"quiesced": false' "$MANIFEST" 2>/dev/null; then
    log "NOTE: this snapshot was NOT taken during a proven quiet window, so the"
    log "      set of files may be from slightly different instants. Usually"
    log "      harmless here; see the header of backup.sh."
  fi
  if grep -q '"json_invalid": \[".' "$MANIFEST" 2>/dev/null; then
    log "NOTE: the manifest records invalid JSON inside this snapshot — the live"
    log "      data was already damaged when it was taken."
  fi
else
  log "WARNING: no manifest beside the archive (older snapshot, or copied without it)"
fi

# ── 4. extract to a staging dir on the TARGET filesystem ────────────────────
# Sibling of the data dir on purpose: the swap below must be a rename, and
# rename is only atomic within one filesystem. Extracting to /tmp and moving
# across a mount point would turn the swap into a slow copy with a window in
# which the data dir is half-populated.
TARGET_PARENT=$(dirname "$(readlink -m "$DATA_DIR")")
mkdir -p "$TARGET_PARENT" || die "cannot create $TARGET_PARENT"
STAGE=$(mktemp -d "$TARGET_PARENT/.restore-XXXXXX") || die "cannot create a staging dir in $TARGET_PARENT"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# -p and --numeric-owner: users.json is 0600 and .jwt_secret is credential
# material. A restore that widens those modes is a security regression, and
# resolving a stored user NAME to a uid in a different container is a guess.
tar -xzf "$ARCHIVE" -C "$STAGE" -p --numeric-owner 2>>"$LOG" \
  || die "the archive will not extract"

PAYLOAD="$STAGE/payload"
[ -d "$PAYLOAD" ] || die "the archive has no payload/ directory — it was not produced by deploy/backup.sh"

N=$(find "$PAYLOAD" -type f | wc -l)
[ "$N" -gt 0 ] || die "the payload is empty — refusing to replace live data with nothing"
log "payload: $N files"

# ── 5. validate the payload BEFORE touching live data ───────────────────────
BAD=""
if have_python; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$PAYLOAD/$f" \
      >/dev/null 2>&1 || BAD="$BAD $f"
  done <<<"$(find "$PAYLOAD" -type f -name '*.json' -printf '%P\n' 2>/dev/null | LC_ALL=C sort)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    python3 -c "
import json,sys
for n, line in enumerate(open(sys.argv[1], encoding='utf-8'), 1):
    if line.strip():
        json.loads(line)
" "$PAYLOAD/$f" >/dev/null 2>&1 || BAD="$BAD $f"
  done <<<"$(find "$PAYLOAD" -type f -name '*.jsonl' -printf '%P\n' 2>/dev/null | LC_ALL=C sort)"
else
  log "WARNING: python3 not found — cannot validate the payload's JSON"
fi

if [ -n "$BAD" ]; then
  log "the payload contains files that are not valid JSON:$BAD"
  if [ "$FORCE" = true ]; then
    log "WARNING: --force given; restoring the damaged snapshot anyway"
  else
    die "refusing to restore a snapshot whose contents do not parse. Try an older snapshot, or re-run with --force if this is the only copy you have (the app's readers fall back to .bak siblings, so a partial restore may still be better than nothing)."
  fi
else
  log "payload validates: every JSON and JSONL document parses"
fi

if [ "$VERIFY_ONLY" = true ]; then
  log "VERIFY-ONLY: this snapshot is intact and restorable. Nothing was changed."
  exit 0
fi

# ── 6. refuse to restore under a running backend ────────────────────────────
# The backend holds no durable in-memory state, but it does cache reads and
# will happily write a stale document back over the files we just restored.
# Docker is absent in a scratch-dir test, which is why this is conditional.
backend_running() {
  command -v docker >/dev/null 2>&1 || return 1
  local here cid
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  [ -f "$here/docker-compose.yml" ] || return 1
  cid=$(cd "$here" && docker compose ps -q backend 2>/dev/null)
  [ -n "$cid" ] || return 1
  # `ps -q` alone is not the answer: depending on the Compose version it also
  # prints the id of a container that exists but is stopped, which would make
  # this refuse a restore the operator had already stopped the backend for.
  # Ask Docker for the actual state, the way autodeploy.sh does for health.
  [ "$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]
}

if backend_running; then
  HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [ "$FORCE" = true ]; then
    log "WARNING: the backend is running and --force was given. It may write cached state over the restore."
  else
    die "the backend container is running. Stop it first, or the restore can be overwritten:
       cd $HERE && docker compose stop backend
       sudo bash $HERE/restore.sh $ORIG_ARGS --yes
       cd $HERE && docker compose start backend
     (--force overrides this.)"
  fi
fi

# ── 7. confirm ──────────────────────────────────────────────────────────────
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ASIDE="$(readlink -m "$DATA_DIR").pre-restore-$STAMP"
EXISTING=0
[ -d "$DATA_DIR" ] && EXISTING=$(find "$DATA_DIR" -type f 2>/dev/null | wc -l)

echo
echo "  restore plan"
echo "  ------------"
echo "  from:        $ARCHIVE"
echo "  into:        $(readlink -m "$DATA_DIR")   ($EXISTING file(s) there now)"
echo "  payload:     $N file(s)"
if [ "$EXISTING" -gt 0 ]; then
  echo "  moved aside: $ASIDE   (NOT deleted)"
else
  echo "  moved aside: nothing — the target is empty or missing"
fi
echo

if [ "$DRY_RUN" = true ]; then
  log "DRY-RUN: nothing was changed."
  exit 0
fi

if [ "$ASSUME_YES" != true ]; then
  if [ ! -t 0 ]; then
    die "not a terminal and --yes was not given; refusing to restore unattended"
  fi
  printf 'Type "restore" to proceed: '
  read -r answer
  [ "$answer" = restore ] || die "cancelled"
fi

# ── 8. swap ─────────────────────────────────────────────────────────────────
# Move the old directory aside, then rename the payload into place. Two
# renames rather than a copy, so the data dir is never half-populated, and the
# previous contents are still on disk afterwards.
MOVED_ASIDE=false
if [ -d "$DATA_DIR" ]; then
  mv "$(readlink -m "$DATA_DIR")" "$ASIDE" || die "cannot move the existing data dir aside"
  MOVED_ASIDE=true
  log "moved the existing data dir to $ASIDE"
fi
mv "$PAYLOAD" "$(readlink -m "$DATA_DIR")" || die "cannot move the payload into place (the previous data is at $ASIDE)"
log "restored $N files into $(readlink -m "$DATA_DIR")"

# ── 9. verify the restore landed ────────────────────────────────────────────
LIVE=$(find "$DATA_DIR" -type f | wc -l)
[ "$LIVE" -eq "$N" ] || die "expected $N files after the restore but found $LIVE (previous data is at $ASIDE)"
if have_python && [ -f "$DATA_DIR/users.json" ]; then
  ACCOUNTS=$(python3 -c "
import json,sys
d = json.load(open(sys.argv[1]))
print(len(d.get('users', d) if isinstance(d, dict) else []))
" "$DATA_DIR/users.json" 2>/dev/null || echo '?')
  log "users.json restored with $ACCOUNTS account(s)"
fi
log "restore complete"

cat <<TXT

  Next:
    cd $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) && docker compose up -d
    curl -fsS https://<domain>/healthz
TXT

if [ "$MOVED_ASIDE" = true ]; then
  cat <<TXT

  The data directory this replaced is still on disk at:
    $ASIDE
  Diff it against the restore if you want to see what the snapshot was missing.
  Delete it once you are satisfied. Nothing will do that for you — an automatic
  cleanup here would remove the only copy of anything the snapshot predates.
TXT
fi
