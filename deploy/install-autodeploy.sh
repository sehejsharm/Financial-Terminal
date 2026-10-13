#!/usr/bin/env bash
# One-shot installer for the self-updating deployment (run as root).
#
# After this runs once, the VM needs NO further human interaction:
#   - 2G swap (idempotent) — the missing piece behind every build hang/crash
#     on this 1GB machine
#   - systemd timer runs deploy/autodeploy.sh every 4 minutes: the VM pulls
#     new commits and rebuilds itself (no SSH, no CI secrets)
#   - health watchdog cron (restarts a hung backend) stays installed
#   - systemd timer runs deploy/backup.sh daily and snapshots the data volume
#   - kicks off an immediate deploy of whatever is currently on origin
set -eu

REPO=/home/ubuntu/Financial-Terminal

echo "[1/7] swap (2G, idempotent)…"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
free -h | grep -i swap

echo "[2/7] git safe.directory for root…"
git config --global --add safe.directory "$REPO" || true

echo "[3/7] systemd auto-deploy timer (every 4 min)…"
install -m 755 "$REPO/deploy/autodeploy.sh" /usr/local/bin/mb-autodeploy

cat >/etc/systemd/system/mb-autodeploy.service <<'UNIT'
[Unit]
Description=Motherboard pull-based auto-deploy
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mb-autodeploy
UNIT

cat >/etc/systemd/system/mb-autodeploy.timer <<'UNIT'
[Unit]
Description=Run Motherboard auto-deploy every 4 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=4min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now mb-autodeploy.timer

echo "[4/7] watchdog cron (auto-restart hung backend)…"
cat >/etc/cron.d/motherboard-watchdog <<CRON
*/2 * * * * root cd $REPO/deploy && bash watchdog.sh >> /var/log/mb-watchdog.log 2>&1
CRON
chmod 644 /etc/cron.d/motherboard-watchdog

echo "[5/7] systemd backup timer (daily snapshot of the data volume)…"
# NOTE THE DIFFERENCE FROM STEP 3: autodeploy is *copied* to /usr/local/bin
# because it `git reset --hard`s the very repo it lives in — running a script
# that is being rewritten underneath you is the reason for that copy. backup.sh
# does not touch the repo, so its unit points straight at the working tree and
# a `git pull` is enough to update it. The copy in step 3 is also why the
# health gate and rollback sat inert for a while: nothing refreshed it. Do not
# "make this consistent" by copying this one too.
# 0700: the archives contain users.json (password hashes) and .jwt_secret
# (forge-a-session material). A backup directory is as sensitive as the
# database it holds, and the default 0755 would make it world-readable.
install -d -m 700 /var/backups/motherboard

# The off-host destination lives in its own file rather than an Environment=
# line in the unit, for two reasons: the hook string contains "$1" and systemd's
# handling of $ in unit values is a quoting trap, and the setting usually sits
# next to a credential — a file at 0600 keeps it out of `systemctl show`, which
# any user can run. Created empty-but-commented and never overwritten, so
# re-running this installer does not wipe what the operator configured.
OFFHOST_ENV=/etc/motherboard-backup.env
if [ ! -f "$OFFHOST_ENV" ]; then
  cat >"$OFFHOST_ENV" <<'ENVFILE'
# Off-host backup destination for deploy/backup.sh. UNCOMMENT AND FILL IN ONE.
#
# The value is a shell command run with the snapshot's paths as arguments:
#   $1 = archive (.tar.gz)   $2 = its .sha256   $3 = its .manifest.json
# Keep the single quotes: $1 must reach the command, not be expanded here.
# Send all three — without the .sha256 a fetched archive cannot be verified,
# and restore.sh refuses an unverifiable archive by default.
#
# MB_BACKUP_OFFHOST_CMD='for f in "$1" "$2" "$3"; do rclone copy "$f" remote:motherboard/; done'
# MB_BACKUP_OFFHOST_CMD='scp "$1" "$2" "$3" backup@HOST:/srv/motherboard/'
# MB_BACKUP_OFFHOST_CMD='aws s3 cp "$1" s3://BUCKET/mb/ && aws s3 cp "$2" s3://BUCKET/mb/'
#
# After editing: systemctl restart mb-backup.service   (takes a snapshot now)
# Then prove it: fetch the archive back and run
#   bash deploy/restore.sh /path/to/fetched.tar.gz --verify-only
ENVFILE
  chmod 600 "$OFFHOST_ENV"
  echo "    created $OFFHOST_ENV (off-host destination goes here)"
else
  echo "    $OFFHOST_ENV already exists — left alone"
fi

cat >/etc/systemd/system/mb-backup.service <<UNIT
[Unit]
Description=Motherboard data-volume backup
After=docker.service
# Intentionally no Requires=docker.service: the data directory is a plain bind
# mount on the host, so a snapshot is worth taking even when Docker is broken —
# which is exactly when someone is about to start deleting things.

[Service]
Type=oneshot
ExecStart=/bin/bash $REPO/deploy/backup.sh
# Leading '-': a missing file is not a failure, so the local snapshot still
# runs on a host where the operator has not set a destination yet.
EnvironmentFile=-$OFFHOST_ENV
# Backups must never compete with a build or a request for CPU or disk on a
# 1GB VM. Lowest CPU priority and idle I/O: the snapshot takes a little longer
# and nothing a user is waiting on gets slower.
Nice=19
IOSchedulingClass=idle
# The off-host hook is a network upload; cap it so a hung transfer cannot hold
# the flock and starve every later tick.
TimeoutStartSec=30min
UNIT

cat >/etc/systemd/system/mb-backup.timer <<'UNIT'
[Unit]
Description=Snapshot the Motherboard data volume daily

[Timer]
# Host local time. Snapshot filenames are UTC regardless, so the archives sort
# chronologically whatever the VM's timezone is.
OnCalendar=*-*-* 03:17:00
# Spread the start so this never lands on the same instant as every other
# cron-at-03:00 on the host.
RandomizedDelaySec=15min
# A VM that was powered off at 03:17 runs the backup when it next boots,
# instead of silently skipping a day.
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now mb-backup.timer
systemctl list-timers --no-pager mb-backup.timer | head -3

echo "[6/7] proving the backup actually restores…"
# Runs against throwaway temp directories — it touches neither the real data
# dir nor the real backup dir. The point is that the operator leaves this
# install with a *demonstrated* restore rather than a believed one, which is
# the whole difference between having backups and thinking you do.
if bash "$REPO/deploy/backup.sh" --self-test; then
  echo "    round trip verified; taking the first real snapshot now"
  # Don't wait up to 24h for the timer to give this VM its first backup.
  bash "$REPO/deploy/backup.sh" || echo "    (first snapshot returned $? — see /var/log/mb-backup.log)"
else
  echo "    !! BACKUP SELF-TEST FAILED — do not trust the timer. Fix this before"
  echo "    !! relying on it; the install continues so the deploy still happens."
fi

echo "[7/7] immediate first deploy of latest origin…"
/usr/local/bin/mb-autodeploy --force || true

echo "== install complete =="
echo "-- containers --"
cd "$REPO/deploy" && docker compose ps
echo "-- last autodeploy log lines --"
tail -n 12 /var/log/mb-autodeploy.log 2>/dev/null || echo "(no log yet — nothing new to deploy)"
echo "-- backups --"
ls -lh /var/backups/motherboard/*.tar.gz 2>/dev/null || echo "(none yet — see /var/log/mb-backup.log)"
# Only an UNcommented assignment counts as configured.
if ! grep -qE '^[[:space:]]*MB_BACKUP_OFFHOST_CMD=' "$OFFHOST_ENV" 2>/dev/null; then
  cat <<TXT

   !! OFF-HOST BACKUP IS NOT CONFIGURED.
   !! Snapshots exist only on this VM, so they do not survive losing the
   !! instance or its boot volume — the failure a backup is actually for.
   !! Set MB_BACKUP_OFFHOST_CMD in $OFFHOST_ENV (one line, examples are in it),
   !! then: systemctl restart mb-backup.service
   !! Then prove it round-trips: fetch an archive back from the destination and
   !!   bash $REPO/deploy/restore.sh /path/to/fetched.tar.gz --verify-only
TXT
fi
