#!/usr/bin/env bash
# One-shot recovery for "the backend is down / I can't log in".
#
# Run ON THE VM:   sudo bash /home/ubuntu/Financial-Terminal/deploy/recover.sh
#
# Diagnoses and fixes the failure mode this deployment is most prone to: the
# boot volume filling with orphaned Docker images (one is built per commit),
# after which the backend can no longer write data/ and authentication fails.
#
# It is safe to run at any time. It never touches deploy/data (users,
# portfolios, watchlists) except to RESTORE a file that is already corrupt,
# and never removes an image that a running container is using.
set -u

REPO=${REPO:-/home/ubuntu/Financial-Terminal}
cd "$REPO/deploy" || { echo "cannot find $REPO/deploy"; exit 1; }

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

say "1. Disk"
df -h / /var/lib/docker 2>/dev/null | sed 's/^/   /'
FREE=$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')
echo "   free on docker volume: ${FREE:-unknown} MB"

say "2. Containers"
docker compose ps 2>&1 | sed 's/^/   /'

say "3. Reclaiming space"
echo "   docker builder cache + images no container is using:"
docker builder prune -af 2>&1 | tail -2 | sed 's/^/   /'
docker image prune -af 2>&1 | tail -2 | sed 's/^/   /'
# Stopped containers and unused networks; volumes are deliberately NOT pruned
# (caddy_data holds the TLS certs).
docker container prune -f 2>&1 | tail -1 | sed 's/^/   /'
docker network prune -f 2>&1 | tail -1 | sed 's/^/   /'
echo "   free now: $(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}') MB"

say "4. Checking the user database"
U=data/users.json
if [ ! -s "$U" ]; then
  echo "   users.json is MISSING OR EMPTY — this is what breaks login."
  if [ -s "$U.bak" ]; then
    cp -a "$U.bak" "$U"
    echo "   restored from users.json.bak"
  else
    echo "   no .bak available; the admin account will be re-seeded from"
    echo "   deploy/.env (MOTHERBOARD_ADMIN_USER / MOTHERBOARD_ADMIN_PASSWORD)"
    echo "   when the backend restarts below."
  fi
elif ! python3 -c "import json,sys; json.load(open('$U'))" 2>/dev/null; then
  echo "   users.json is present but NOT VALID JSON."
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  cp -a "$U" "$U.corrupt-$ts"
  if [ -s "$U.bak" ] && python3 -c "import json;json.load(open('$U.bak'))" 2>/dev/null; then
    cp -a "$U.bak" "$U"
    echo "   restored from users.json.bak (bad copy kept as users.json.corrupt-$ts)"
  else
    rm -f "$U"
    echo "   no usable backup; removed it so the admin is re-seeded from .env"
  fi
else
  n=$(python3 -c "import json;print(len(json.load(open('$U')).get('users',{})))" 2>/dev/null || echo '?')
  echo "   OK — $n account(s)"
fi

say "5. Restarting the stack"
docker compose up -d 2>&1 | tail -5 | sed 's/^/   /'

say "6. Waiting for health"
for i in $(seq 1 30); do
  if docker compose exec -T backend python -c \
      "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz',timeout=5)" \
      >/dev/null 2>&1; then
    echo "   backend healthy after ${i}0s"
    break
  fi
  sleep 10
  [ "$i" = 30 ] && echo "   STILL UNHEALTHY — see logs below"
done

say "7. Recent backend logs"
docker compose logs --tail 40 backend 2>&1 | sed 's/^/   /'

say "Done"
cat <<'TXT'
   If login still fails, the admin password is whatever is set in
   deploy/.env as MOTHERBOARD_ADMIN_PASSWORD — that file is the source of
   truth and is re-applied on every backend boot. Change it there and run
   `docker compose restart backend`.

   If disk was the problem it is now pruned, and deploy/autodeploy.sh prunes
   automatically from here on.
TXT
