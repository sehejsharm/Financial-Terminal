#!/usr/bin/env bash
# Bootstrap the Motherboard backend on a fresh Oracle Cloud Ubuntu 22.04 VM.
#
# Idempotent — safe to re-run (e.g. after editing .env or pulling new code).
# Run it from the repo's deploy/ directory:
#
#   cd ~/Financial-Terminal/deploy
#   cp .env.example .env && nano .env      # fill in DOMAIN + secrets
#   bash setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: deploy/.env not found." >&2
  echo "Run:  cp .env.example .env  then edit it, then re-run this script." >&2
  exit 1
fi

DOMAIN_VAL="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2-)"
if [[ -z "${DOMAIN_VAL}" || "${DOMAIN_VAL}" == "motherboard-sehej.duckdns.org" ]]; then
  echo "WARNING: DOMAIN in .env still looks like the placeholder (${DOMAIN_VAL})."
  echo "         Caddy will fail to get an HTTPS cert unless this is YOUR DuckDNS"
  echo "         subdomain pointing at this VM's public IP. Continuing anyway…"
fi

echo "→ [1/4] Installing Docker (if needed)…"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  echo "    Docker already installed: $(docker --version)"
fi

echo "→ [2/4] Opening the host firewall for 80/443…"
# Oracle's Ubuntu images ship an iptables REJECT for everything except SSH, so
# even with the cloud Security List open, inbound 80/443 is dropped on the host
# until we insert ACCEPT rules ABOVE that REJECT. (-C avoids duplicates.)
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  fi
done
# Persist across reboots.
if ! command -v netfilter-persistent >/dev/null 2>&1; then
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | sudo debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | sudo debconf-set-selections
  sudo apt-get install -y iptables-persistent
fi
sudo netfilter-persistent save

echo "→ [3/5] Building + starting containers…"
sudo docker compose up -d --build

echo "→ [4/5] Installing health watchdog (cron, every 2 min)…"
# Restarts the backend automatically if it hangs (Docker healthcheck goes
# unhealthy). Crashes are already covered by restart: unless-stopped.
sudo tee /etc/cron.d/motherboard-watchdog >/dev/null <<CRON
*/2 * * * * root cd $(pwd) && bash watchdog.sh >> /var/log/mb-watchdog.log 2>&1
CRON
sudo chmod 644 /etc/cron.d/motherboard-watchdog

echo "→ [5/5] Status:"
sleep 5
sudo docker compose ps
echo
echo "✓ Up. First TLS cert takes ~30–60s. Then check:"
echo "    curl https://${DOMAIN_VAL}/healthz"
echo "    curl https://${DOMAIN_VAL}/diag"
echo "  Tail logs with:  sudo docker compose logs -f"
