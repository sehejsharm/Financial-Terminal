#!/usr/bin/env bash
# One-shot installer for the self-updating deployment (run as root).
#
# After this runs once, the VM needs NO further human interaction:
#   - 2G swap (idempotent) — the missing piece behind every build hang/crash
#     on this 1GB machine
#   - systemd timer runs deploy/autodeploy.sh every 4 minutes: the VM pulls
#     new commits and rebuilds itself (no SSH, no CI secrets)
#   - health watchdog cron (restarts a hung backend) stays installed
#   - kicks off an immediate deploy of whatever is currently on origin
set -eu

REPO=/home/ubuntu/Financial-Terminal

echo "[1/5] swap (2G, idempotent)…"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
free -h | grep -i swap

echo "[2/5] git safe.directory for root…"
git config --global --add safe.directory "$REPO" || true

echo "[3/5] systemd auto-deploy timer (every 4 min)…"
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

echo "[4/5] watchdog cron (auto-restart hung backend)…"
cat >/etc/cron.d/motherboard-watchdog <<CRON
*/2 * * * * root cd $REPO/deploy && bash watchdog.sh >> /var/log/mb-watchdog.log 2>&1
CRON
chmod 644 /etc/cron.d/motherboard-watchdog

echo "[5/5] immediate first deploy of latest origin…"
/usr/local/bin/mb-autodeploy --force || true

echo "== install complete =="
echo "-- containers --"
cd "$REPO/deploy" && docker compose ps
echo "-- last autodeploy log lines --"
tail -n 12 /var/log/mb-autodeploy.log 2>/dev/null || echo "(no log yet — nothing new to deploy)"
