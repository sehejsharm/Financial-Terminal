#!/usr/bin/env bash
# Snapshot the backend's data volume — accounts, sessions, notes, portfolios,
# watchlists, workspaces, alerts, invites, usage, grievances, the audit log and
# the JWT secret.
#
# WHY THIS EXISTS: there was no backup at all. docker-compose.yml bind-mounts
# ./data into the backend and that directory is the entire database. One bad
# volume, one `rm -rf`, one filled disk at the wrong moment, and every account
# and every audit record is gone with nothing to go back to. lib/atomic.py
# protects a single file from a failed write; it does not protect the directory
# from being lost.
#
#   Run manually:  sudo bash deploy/backup.sh
#   Prove it works: sudo bash deploy/backup.sh --self-test
#   Scheduled:     mb-backup.timer (installed by install-autodeploy.sh)
#   Restore:       deploy/restore.sh
#
# Log: /var/log/mb-backup.log
#
# ── THE WHOLE DIRECTORY, NOT A FILE LIST ────────────────────────────────────
# This copies everything under the data dir rather than enumerating the ten
# known stores. A list is the wrong shape for this job: it only ever fails in
# the direction of silently missing something. .gitignore already learned this
# lesson (see its comment — a per-file list ignored data/notes.json but not
# data/notes.json.bak). The directory holds more than the obvious ten:
# `.jwt_secret` (lose it and every signed-in user is logged out even though
# users.json survived), INITIAL_ADMIN_PASSWORD.txt, the vc_* value-chain
# stores, notify_settings.json, the writer's `.bak` siblings and any
# `.corrupt-*` quarantine files. Every feature that adds a store is covered
# without anyone remembering to edit this script.
#
# ── ON A CONSISTENT SET ─────────────────────────────────────────────────────
# lib/atomic.py makes each FILE atomic: a reader sees the whole old document or
# the whole new one. It says nothing about the SET. A signup writes users.json
# and then appends to audit.jsonl; a naive copy taken between those two writes
# yields a snapshot with an account that has no audit trail. Worse pairings
# exist — a portfolio that references a watchlist id the watchlists file in the
# same snapshot does not have.
#
# The honest fix for a Postgres-backed store is a transaction. There is no
# transaction here, so this does the next best thing that does not require
# stopping the service: it copies, then re-fingerprints every file
# (path + size + mtime) and compares against the fingerprint taken before the
# copy. If anything moved, the copy is thrown away and retried. A snapshot is
# only labelled `"quiesced": true` when a full pass completed with nothing
# changing underneath it.
#
# That is a *proof of a quiet window*, not a lock — a write could in principle
# land and be reverted inside one pass, and mtime granularity could hide a
# second write in the same nanosecond bucket. For this workload (a handful of
# small documents, write rates measured in events per minute, no Postgres) a
# proven quiet window is the strongest guarantee available without downtime,
# and the retry makes an unquiesced result rare. When it does happen the
# snapshot is still kept — a possibly-torn snapshot beats no snapshot — but it
# is marked in the manifest and the script exits 3 so the timer records it.
#
# For a guaranteed-consistent snapshot, stop the backend first:
#   cd deploy && docker compose stop backend && bash backup.sh && docker compose start backend
# That is ~15s of downtime and is what to do before a risky migration.
set -u

# ── config (env overrides exist so this is testable against a scratch dir) ───
DATA_DIR=${MB_DATA_DIR:-/home/ubuntu/Financial-Terminal/deploy/data}
BACKUP_DIR=${MB_BACKUP_DIR:-/var/backups/motherboard}
LOG=${MB_BACKUP_LOG:-/var/log/mb-backup.log}
# How many snapshots to keep. Daily timer, so 14 is a fortnight — long enough
# that damage noticed a week late is still recoverable.
KEEP=${MB_BACKUP_KEEP:-14}
# Second, independent ceiling. KEEP alone bounds the COUNT; if the data dir
# grows the total can still run away, and this VM's boot volume is the same one
# Docker builds on. Whichever limit bites first wins.
MAX_TOTAL_MB=${MB_BACKUP_MAX_TOTAL_MB:-512}
# Matches MIN_FREE_MB in autodeploy.sh, and for the same reason: below this a
# build fails and the backend can no longer write data/. A backup must never be
# the thing that causes the outage it exists to recover from, so it refuses to
# run rather than consume the last of the volume.
MIN_FREE_MB=${MB_BACKUP_MIN_FREE_MB:-4096}
QUIESCE_TRIES=${MB_BACKUP_QUIESCE_TRIES:-4}
QUIESCE_WAIT_SEC=${MB_BACKUP_QUIESCE_WAIT_SEC:-2}
# Overridable only so the retention test can mint predictable names.
STAMP=${MB_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
PREFIX=mb-data

# ── OFF-HOST: THE OPERATOR FILLS THIS IN ────────────────────────────────────
# A snapshot on the same VM as the data survives `rm -rf data/`, a corrupt
# write and a bad deploy. It does NOT survive the failure that actually
# destroys companies: losing the instance or its boot volume. Off-host is the
# point of a backup.
#
# No provider is chosen here and no credential is invented. Set ONE env var,
# MB_BACKUP_OFFHOST_CMD, to a shell command. On the VM its home is
# /etc/motherboard-backup.env (created at mode 0600 by install-autodeploy.sh and
# read by mb-backup.service); that file rather than the unit, because the value
# usually sits beside a credential and `systemctl show` is readable by anyone.
# It runs with:   $1 = archive path   $2 = checksum path   $3 = manifest path
# A nonzero exit is reported and makes this script exit 5; the local snapshot
# is still kept.
#
# Push ALL THREE. The archive alone restores, but without the .sha256 beside it
# restore.sh cannot verify what came back and refuses by default — and silent
# truncation in transit is exactly what the checksum is for. Examples; put the
# credential in the env file, not here:
#   MB_BACKUP_OFFHOST_CMD='for f in "$1" "$2" "$3"; do rclone copy "$f" remote:motherboard/; done'
#   MB_BACKUP_OFFHOST_CMD='aws s3 cp "$1" s3://BUCKET/mb/ && aws s3 cp "$2" s3://BUCKET/mb/ && aws s3 cp "$3" s3://BUCKET/mb/'
#   MB_BACKUP_OFFHOST_CMD='scp "$1" "$2" "$3" backup@elsewhere:/srv/motherboard/'
# Whatever you choose, restore FROM it once before believing it:
#   fetch an archive back, then  bash restore.sh <fetched.tar.gz> --verify-only
OFFHOST_CMD=${MB_BACKUP_OFFHOST_CMD:-}

offhost_push() {
  if [ -z "$OFFHOST_CMD" ]; then
    return 90   # not configured — distinguished from "configured and failed"
  fi
  # bash -c with positional args rather than eval: the hook still gets a full
  # shell (it needs one for a pipe or an rclone flag) but the paths arrive as
  # arguments instead of being spliced into the command text.
  bash -c "$OFFHOST_CMD" mb-backup-offhost "$1" "$2" "$3"
}

# ── plumbing ────────────────────────────────────────────────────────────────
# Exit codes, so the timer and the operator can tell these apart:
#   0  snapshot taken, verified, quiescent, all JSON parsed
#   1  NO SNAPSHOT — bad config, no disk, tar failed, or verification failed
#   3  snapshot taken and verified, but a quiet window could not be proven
#   4  snapshot taken and verified, but a file in it is not valid JSON
#      (that means the LIVE data is already damaged — see deploy/recover.sh)
#   5  snapshot taken and verified locally, but the off-host push failed
WARN_RC=0
warn_rc() { [ "$1" -gt "$WARN_RC" ] && WARN_RC=$1; return 0; }

log() {
  local line="$(date -Is) $*"
  echo "$line"
  # Best-effort: a scratch-dir run by a non-root user has no business failing
  # because /var/log is not writable.
  { echo "$line" >>"$LOG"; } 2>/dev/null || true
}
die() { log "ABORT: $*"; exit 1; }

have_python() { command -v python3 >/dev/null 2>&1; }

usage() {
  cat <<'TXT'
Usage: backup.sh [--self-test] [--help]

Takes a verified, retained snapshot of the backend data directory.

  --self-test   Prove the backup AND the restore work, end to end, against
                throwaway directories. Touches neither the real data dir nor
                the real backup dir. Run this on the VM after install and
                after changing either script.

Environment (all optional):
  MB_DATA_DIR                 default /home/ubuntu/Financial-Terminal/deploy/data
  MB_BACKUP_DIR               default /var/backups/motherboard
  MB_BACKUP_KEEP              default 14 snapshots
  MB_BACKUP_MAX_TOTAL_MB      default 512
  MB_BACKUP_MIN_FREE_MB       default 4096 (refuses to run below this)
  MB_BACKUP_OFFHOST_CMD       off-host hook; $1=archive $2=sha256 $3=manifest
TXT
}

# ── self-test ───────────────────────────────────────────────────────────────
# Lives in the script it tests so it cannot drift away from it, and so the
# operator can prove the round trip on the real host without a test harness.
self_test() {
  local here; here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  local restore="$here/restore.sh"
  [ -f "$restore" ] || { echo "self-test: $restore not found"; return 1; }

  local w; w=$(mktemp -d)
  # Deliberately NOT cleaned up on failure: if the round trip breaks, the
  # staged copy, the archive and the diff are the evidence. Each case below
  # returns early, so the rm only runs on the success path.
  echo "self-test working dir: $w"
  mkdir -p "$w/data"
  # Shaped like the real thing: a 0600 credential file, a dot-file secret, an
  # append-only log, a .bak sibling, and a writer temp file that must NOT
  # come back.
  printf '%s' '{"users":{"admin":{"pw_hash":"x","role":"master_admin"}}}' >"$w/data/users.json"
  cp "$w/data/users.json" "$w/data/users.json.bak"
  printf '%s' '{"admin":[{"sid":"abc","exp":1}]}'  >"$w/data/sessions.json"
  printf '%s' '{"admin":[{"sym":"RELIANCE","qty":10}]}' >"$w/data/portfolios.json"
  printf '%s\n' '{"ev":"login"}' '{"ev":"screen"}' >"$w/data/audit.jsonl"
  printf '%s' 'jwt-secret-material'                >"$w/data/.jwt_secret"
  chmod 600 "$w/data/users.json" "$w/data/.jwt_secret"
  printf '%s' '{"half-writ'                        >"$w/data/users.json.zz99.tmp"

  cp -a "$w/data" "$w/reference"
  rm -f "$w/reference"/*.tmp

  echo "--- snapshot ---"
  MB_DATA_DIR="$w/data" MB_BACKUP_DIR="$w/backups" MB_BACKUP_LOG="$w/backup.log" \
    MB_BACKUP_OFFHOST_CMD= bash "${BASH_SOURCE[0]}" || {
      echo "self-test FAILED: backup exited $?"; return 1; }

  echo "--- destroy the data dir (what a lost volume looks like) ---"
  rm -rf "$w/data"

  echo "--- restore ---"
  MB_DATA_DIR="$w/data" MB_BACKUP_DIR="$w/backups" MB_BACKUP_LOG="$w/backup.log" \
    bash "$restore" --latest --yes || {
      echo "self-test FAILED: restore exited $?"; return 1; }

  echo "--- diff reference vs restored (must be empty) ---"
  if diff -r "$w/reference" "$w/data"; then
    echo "(no output above = byte-identical)"
  else
    echo "self-test FAILED: restored data differs from the original"; return 1
  fi

  local mode; mode=$(stat -c '%a' "$w/data/users.json")
  [ "$mode" = "600" ] || { echo "self-test FAILED: users.json mode $mode, expected 600"; return 1; }
  [ -f "$w/data/.jwt_secret" ] || { echo "self-test FAILED: .jwt_secret not restored"; return 1; }
  ! ls "$w/data"/*.tmp >/dev/null 2>&1 || { echo "self-test FAILED: a writer .tmp file was restored"; return 1; }

  rm -rf "$w"
  echo
  echo "self-test PASSED: snapshot -> destroy -> restore -> empty diff,"
  echo "                  modes preserved, .jwt_secret intact, temp files excluded."
  echo "                  (working dir removed; it is kept on failure for evidence)"
  return 0
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --help|-h)   usage; exit 0 ;;
  "")          ;;
  *)           usage; exit 1 ;;
esac

# ── 1. validate configuration before touching anything ──────────────────────
[ -d "$DATA_DIR" ] || die "data dir does not exist: $DATA_DIR"

# readlink -m resolves without requiring the path to exist yet.
D_ABS=$(readlink -m "$DATA_DIR")
B_ABS=$(readlink -m "$BACKUP_DIR")

# Nesting either way is a trap: backups inside the data dir get snapshotted
# into the next snapshot (and restored over live data); a data dir inside the
# backup dir gets deleted by retention.
case "$B_ABS/" in "$D_ABS"/*) die "backup dir $B_ABS is inside the data dir $D_ABS" ;; esac
case "$D_ABS/" in "$B_ABS"/*) die "data dir $D_ABS is inside the backup dir $B_ABS" ;; esac

# The manifest is written with printf, so a quote or backslash in a path would
# emit invalid JSON. Refusing is better than writing a manifest that cannot be
# parsed at the moment it is needed.
case "$D_ABS$B_ABS" in *'"'*|*'\'*) die "paths must not contain quotes or backslashes" ;; esac

mkdir -p "$B_ABS" || die "cannot create backup dir $B_ABS"

# One run at a time. A slow off-host push must not overlap the next timer tick.
exec 9>"$B_ABS/.lock"
flock -n 9 || { log "another backup is running — skipping this tick"; exit 0; }

log "=== backup start: $D_ABS -> $B_ABS (stamp $STAMP) ==="

# ── 2. disk guard ───────────────────────────────────────────────────────────
free_mb()  { df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
need_mb()  { du -sm "$1" 2>/dev/null | awk '{print $1}'; }

NEED=$(need_mb "$D_ABS"); NEED=${NEED:-1}
FREE=$(free_mb "$B_ABS"); FREE=${FREE:-0}
log "data dir ${NEED}MB; ${FREE}MB free on the backup volume"

# ── retention, defined here because the disk guard may need to run it early ─
# Deletes an archive and its checksum and manifest together — a pruned archive
# that leaves its manifest behind looks like a snapshot that exists.
snapshots() { ls -1 "$B_ABS/$PREFIX-"*.tar.gz 2>/dev/null | LC_ALL=C sort; }

drop_snapshot() {
  local a=$1
  rm -f "$a" "$a.sha256" "${a%.tar.gz}.manifest.json"
  log "pruned $(basename "$a")"
}

prune() {
  local list n i=0
  list=$(snapshots); [ -z "$list" ] && return 0
  n=$(printf '%s\n' "$list" | wc -l)

  # By count.
  if [ "$n" -gt "$KEEP" ]; then
    printf '%s\n' "$list" | head -n "$((n - KEEP))" | while IFS= read -r a; do
      drop_snapshot "$a"
    done
  fi

  # By total size. Always leave one behind: a disk so full that a single
  # snapshot will not fit is a disk problem, and deleting the last backup to
  # make room is how you end up with none.
  while :; do
    list=$(snapshots); [ -z "$list" ] && break
    n=$(printf '%s\n' "$list" | wc -l)
    [ "$n" -le 1 ] && break
    local total
    total=$(du -sm "$B_ABS" 2>/dev/null | awk '{print $1}')
    [ -z "$total" ] && break
    [ "$total" -le "$MAX_TOTAL_MB" ] && break
    drop_snapshot "$(printf '%s\n' "$list" | head -1)"
    i=$((i + 1)); [ "$i" -gt 500 ] && break   # paranoia; never loop forever
  done
}

if [ "$((FREE - NEED))" -lt "$MIN_FREE_MB" ]; then
  log "low disk — pruning old snapshots before taking a new one"
  prune
  FREE=$(free_mb "$B_ABS"); FREE=${FREE:-0}
  if [ "$((FREE - NEED))" -lt "$MIN_FREE_MB" ]; then
    die "only ${FREE}MB free and the snapshot needs ~${NEED}MB; refusing to take the volume below ${MIN_FREE_MB}MB. Free space first (deploy/recover.sh prunes Docker), then re-run."
  fi
fi

# ── 3. stage a copy and prove it was taken during a quiet window ────────────
STAGE=$(mktemp -d "$B_ABS/.stage-$STAMP.XXXXXX") || die "cannot create staging dir"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# path|size|mtime for every file. mtime at nanosecond resolution via %T@.
fingerprint() {
  find "$D_ABS" -type f -printf '%P|%s|%T@\n' 2>/dev/null | LC_ALL=C sort
}

QUIESCED=false
ATTEMPT=0
while [ "$ATTEMPT" -lt "$QUIESCE_TRIES" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  BEFORE=$(fingerprint)
  rm -rf "$STAGE/payload"
  mkdir -p "$STAGE/payload" || die "cannot create staging payload dir"
  # -a: modes, ownership and timestamps. users.json is 0600 and .jwt_secret is
  # a credential; a restore that widens either is a security regression.
  # "$D_ABS/." rather than "$D_ABS" so dot-files (.jwt_secret) are included.
  cp -a "$D_ABS/." "$STAGE/payload/" || die "copy failed"
  AFTER=$(fingerprint)
  if [ "$BEFORE" = "$AFTER" ]; then
    QUIESCED=true
    break
  fi
  log "data changed during copy (attempt $ATTEMPT/$QUIESCE_TRIES) — retrying"
  sleep "$QUIESCE_WAIT_SEC"
done

if [ "$QUIESCED" = true ]; then
  log "quiesced: nothing changed during the copy pass (attempt $ATTEMPT)"
else
  log "WARNING: could not prove a quiet window after $QUIESCE_TRIES attempts — keeping the snapshot but marking it not quiesced"
  warn_rc 3
fi

# ── 4. clean the staged copy ────────────────────────────────────────────────
# The atomic writer's in-flight temp files (lib/atomic.py uses
# mkstemp(prefix=name+'.', suffix='.tmp')). These are half-written documents,
# not data; restoring them would litter the data dir with files nothing ever
# cleans up.
TMP_DROPPED=$(find "$STAGE/payload" -type f -name '*.tmp' -printf '%P\n' 2>/dev/null | LC_ALL=C sort)
find "$STAGE/payload" -type f -name '*.tmp' -delete 2>/dev/null
[ -n "$TMP_DROPPED" ] && log "excluded in-flight writer temp files: $(echo "$TMP_DROPPED" | tr '\n' ' ')"

# audit.jsonl and the other JSONL logs are plain appends (storage.append_audit),
# not atomic replaces, so a copy taken mid-append can end in a partial record.
# Trim to the last complete line: the dropped line is one audit event that was
# being written as the snapshot was taken, and keeping it would hand the
# restore a file whose last line cannot be parsed.
JSONL_TRIMMED=""
if have_python; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if python3 - "$STAGE/payload/$f" <<'PY'
import sys
p = sys.argv[1]
with open(p, 'rb') as fh:
    b = fh.read()
if b and not b.endswith(b'\n'):
    i = b.rfind(b'\n')
    with open(p, 'wb') as fh:
        fh.write(b[:i + 1] if i >= 0 else b'')
    sys.exit(10)
sys.exit(0)
PY
    then :; else
      [ $? -eq 10 ] && JSONL_TRIMMED="$JSONL_TRIMMED $f"
    fi
  done <<<"$(find "$STAGE/payload" -type f -name '*.jsonl' -printf '%P\n' 2>/dev/null | LC_ALL=C sort)"
  [ -n "$JSONL_TRIMMED" ] && log "trimmed a partial trailing record from:$JSONL_TRIMMED"
else
  log "WARNING: python3 not found — skipping the JSONL partial-line trim and the JSON validation below"
fi

# ── 5. validate what we are about to call a backup ──────────────────────────
# Parsing every JSON document now is how a backup earns the name. If a store is
# already corrupt on disk, this is where you find out — months before the
# restore, rather than during it. It does not fail the run: a snapshot of
# damaged data is still the only copy of the undamaged parts.
JSON_BAD=""
JSON_CHECKED=0
if have_python; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    JSON_CHECKED=$((JSON_CHECKED + 1))
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" \
      "$STAGE/payload/$f" >/dev/null 2>&1 || JSON_BAD="$JSON_BAD $f"
  done <<<"$(find "$STAGE/payload" -type f -name '*.json' -printf '%P\n' 2>/dev/null | LC_ALL=C sort)"
fi
if [ -n "$JSON_BAD" ]; then
  log "WARNING: these files in the snapshot are NOT valid JSON (the LIVE data is damaged):$JSON_BAD"
  log "         see deploy/recover.sh — a .bak sibling may still be good"
  warn_rc 4
else
  [ "$JSON_CHECKED" -gt 0 ] && log "all $JSON_CHECKED JSON documents parse"
fi

FILE_COUNT=$(find "$STAGE/payload" -type f | wc -l)
[ "$FILE_COUNT" -gt 0 ] || die "nothing to back up — $D_ABS has no files"

# ── 6. package ──────────────────────────────────────────────────────────────
ARCHIVE="$B_ABS/$PREFIX-$STAMP.tar.gz"
PARTIAL="$B_ABS/.partial-$PREFIX-$STAMP.tar.gz"

# Write to a dot-prefixed name and rename into place, for the same reason
# lib/atomic.py does: a run killed mid-write must not leave something that
# looks like a usable snapshot. `snapshots()` only matches the final name.
rm -f "$PARTIAL"
# --numeric-owner: the restore may run in a different container/userns, where
# resolving a stored name to a uid is a guess.
tar -czf "$PARTIAL" --numeric-owner -C "$STAGE" payload 2>>"$LOG" \
  || { rm -f "$PARTIAL"; die "tar failed"; }

# ── 7. verify the archive, before claiming a backup exists ──────────────────
# Not just `tar -t`. Extract it to a scratch dir and diff it against what was
# staged, because the failure that matters is "the archive is readable but the
# contents are not what I put in it". This is cheap at this size and it is the
# difference between a backup and a belief.
VERIFY="$STAGE/verify"
mkdir -p "$VERIFY"
tar -xzf "$PARTIAL" -C "$VERIFY" 2>>"$LOG" \
  || { rm -f "$PARTIAL"; die "archive will not extract — refusing to keep it"; }
if ! diff -r "$STAGE/payload" "$VERIFY/payload" >"$STAGE/verify.diff" 2>&1; then
  log "verification diff:"; sed 's/^/    /' "$STAGE/verify.diff" | head -20
  rm -f "$PARTIAL"
  die "the archive does not match what was staged — refusing to keep it"
fi
log "verified: archive extracts and matches the staged copy exactly"

mv -f "$PARTIAL" "$ARCHIVE" || die "cannot move the archive into place"

# Checksum stored as a bare basename so `sha256sum -c` works from the backup
# dir, and so the pair stays valid if the directory is moved or synced off-host.
( cd "$B_ABS" && sha256sum "$(basename "$ARCHIVE")" >"$(basename "$ARCHIVE").sha256" ) \
  || die "cannot write the checksum"
SHA=$(awk '{print $1}' "$ARCHIVE.sha256")
BYTES=$(stat -c '%s' "$ARCHIVE")
log "wrote $(basename "$ARCHIVE") (${BYTES} bytes, $FILE_COUNT files, sha256 ${SHA:0:16}…)"

# ── 8. manifest ─────────────────────────────────────────────────────────────
MANIFEST="${ARCHIVE%.tar.gz}.manifest.json"
json_list() {   # space-separated words -> JSON array
  local out="" w
  for w in $1; do out="$out${out:+, }\"$w\""; done
  echo "[$out]"
}
cat >"$MANIFEST" <<JSON
{
  "schema": 1,
  "archive": "$(basename "$ARCHIVE")",
  "created_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stamp": "$STAMP",
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "data_dir": "$D_ABS",
  "payload_root": "payload",
  "sha256": "$SHA",
  "bytes": $BYTES,
  "file_count": $FILE_COUNT,
  "quiesced": $QUIESCED,
  "quiesce_attempts": $ATTEMPT,
  "json_checked": $JSON_CHECKED,
  "json_invalid": $(json_list "$JSON_BAD"),
  "jsonl_trimmed": $(json_list "$JSONL_TRIMMED"),
  "tmp_excluded": $(json_list "$(echo "$TMP_DROPPED" | tr '\n' ' ')"),
  "verified": true,
  "offhost": "OFFHOST_STATUS_PLACEHOLDER"
}
JSON

# ── 9. off-host ─────────────────────────────────────────────────────────────
offhost_push "$ARCHIVE" "$ARCHIVE.sha256" "$MANIFEST"
case $? in
  0)
    OFFHOST_STATUS=sent
    log "off-host push OK"
    ;;
  90)
    OFFHOST_STATUS="not configured"
    # Deliberately loud and repeated on every run. A local-only backup looks
    # exactly like a working backup right up to the moment the volume is gone,
    # so this must not be something the log mentions once at install time.
    log "WARNING: OFF-HOST step is NOT CONFIGURED. This snapshot exists only on"
    log "         this VM. Losing the instance or its boot volume loses it too."
    log "         Set MB_BACKUP_OFFHOST_CMD (see the header of this script)."
    ;;
  *)
    OFFHOST_STATUS=failed
    log "ERROR: the off-host push FAILED — the snapshot is local-only"
    warn_rc 5
    ;;
esac
# Patch the status in rather than reordering the manifest write: the manifest
# must already exist when the hook runs, because the hook is given its path.
sed -i "s/OFFHOST_STATUS_PLACEHOLDER/$OFFHOST_STATUS/" "$MANIFEST"

# ── 10. retention ───────────────────────────────────────────────────────────
prune
KEPT=$(snapshots | wc -l)
log "retention: $KEPT snapshot(s) kept (limits: $KEEP count / ${MAX_TOTAL_MB}MB total), $(free_mb "$B_ABS")MB free"

log "=== backup done (exit $WARN_RC) ==="
exit "$WARN_RC"
