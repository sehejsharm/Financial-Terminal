# Move the backend off Render → Fly.io (5 minutes)

Why: Render free sleeps. Fly's free tier runs always-on (3 shared-cpu-1x VMs,
256 MB each free) and lands closer to most users than Render's single us-east
region. Same Dockerfile, same env vars, no code changes — only the deploy target.

## 1. Install the Fly CLI (one time)

```bash
curl -L https://fly.io/install.sh | sh        # macOS / Linux
# or: iwr https://fly.io/install.ps1 -useb | iex   (Windows PowerShell)
fly auth signup    # opens browser; uses GitHub
```

## 2. Launch the app (reads `fly.toml` in the repo root)

```bash
cd Financial-Terminal
fly launch --copy-config --no-deploy
# Pick a region when prompted. `bom` (Bombay) is closest to NSE; pick
# `iad`, `lhr`, `sin`, etc. if your users are elsewhere.
# DO NOT let Fly add Postgres or upstash unless you want them.
```

This creates the app on Fly without deploying it yet — so you can set secrets first.

## 3. Set secrets (replace with your actual values)

```bash
fly secrets set \
  MOTHERBOARD_ADMIN_USER="Sehej" \
  MOTHERBOARD_ADMIN_PASSWORD="your-strong-password" \
  BACKEND_JWT_SECRET="$(openssl rand -hex 32)" \
  BACKEND_CORS_ORIGINS="https://financial-terminal-peach.vercel.app" \
  GROQ_API_KEY="gsk_..." \
  FRED_API_KEY="..." \
  TWELVE_DATA_API_KEY="..."
```

`TWELVE_DATA_API_KEY` is what unlocks Financials, PEG/Growth screens, full
snapshot fields. Free at https://twelvedata.com (800 calls/day).

## 4. (Optional) Redis for persistent cache

Fly's managed Upstash add-on is the simplest:

```bash
fly redis create     # follow the prompts; pick the same region
fly redis status     # shows the redis:// URL
fly secrets set REDIS_URL="redis://default:...@..."
```

Without this, the cache lives in-process and is fine — just gets a cold first
request after each deploy.

## 5. Deploy

```bash
fly deploy
```

You'll see the Docker build, push, and rollout. ~2–3 min the first time. Watch
logs with `fly logs`. The URL is `https://motherboard-api.fly.dev`
(or whatever name you picked).

Sanity check:

```bash
curl https://motherboard-api.fly.dev/healthz
# {"ok": true}
curl https://motherboard-api.fly.dev/version
# {"service": "motherboard-api", ...}
```

## 6. Point the frontend at the new backend

Vercel dashboard → `financial-terminal` project → **Settings → Environment Variables**:

- `NEXT_PUBLIC_API_URL` → `https://motherboard-api.fly.dev`

Then **Deployments → Redeploy** (Vercel only picks up env vars on a new build).

## 7. Decommission Render (optional, save quota)

In Render dashboard, suspend or delete `motherboard-api` and `motherboard-redis`.
You can also turn off the `keep-render-awake` GitHub Action — Fly never sleeps.

```bash
# delete the cron after migration
rm .github/workflows/keepalive.yml
git add -A && git commit -m "remove render keep-alive (moved to Fly)" && git push
```

## Day-to-day

```bash
fly deploy            # ship a new version
fly logs              # tail logs
fly status            # see machines + health
fly secrets list      # see configured secrets (values hidden)
fly scale memory 1024 # bump RAM if needed (still free if under 3 vCPU-hours/mo)
fly machine restart   # nuke caches without redeploying
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not connect to Redis` in logs | `fly secrets unset REDIS_URL` (cache falls back to in-process). Or re-create the redis add-on. |
| CORS error in browser | `fly secrets set BACKEND_CORS_ORIGINS=https://<exact-vercel-url>` then `fly deploy`. No trailing slash. |
| First request after deploy is slow | Normal: the prewarm thread runs once on boot. Subsequent requests are instant. |
| Out of memory in logs | `fly scale memory 1024` (1 GB is still within the free `shared-cpu-1x` quota). |
