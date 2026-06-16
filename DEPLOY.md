# Deploy Motherboard (frontend on Vercel + backend on Render)

The repo holds three deployables. Pick what you need:

| What | Where | Why |
|---|---|---|
| **Next.js frontend** | **Vercel** | Purpose-built for Next.js; deploy-on-push; CDN. |
| **FastAPI backend** | **Render** (or Fly / Railway) | Long-running Python + Redis. Vercel can't host this comfortably. |
| **Streamlit app** | Streamlit Cloud (already running) | Optional fallback / debugging UI. |

Repo: `sehejsharm/Financial-Terminal` · branch `claude/stock-market-dashboard-2BBMA`.

---

## 1. Deploy the backend first (Render — ~5 min)

The frontend needs the backend URL, so backend goes first.

1. **render.com** → sign in with GitHub → **New → Blueprint**.
2. Pick this repo. Render reads `render.yaml` and proposes one web service
   (`motherboard-api`) and one Redis instance (`motherboard-redis`).
3. Click **Apply**.
4. After the build, open the service → **Environment** → set:
   - `MOTHERBOARD_ADMIN_USER` = `Sehej`
   - `MOTHERBOARD_ADMIN_PASSWORD` = (a strong password — write it down)
   - `GROQ_API_KEY` = `gsk_…` (from console.groq.com)
   - `FRED_API_KEY` = (from fredaccount.stlouisfed.org)
   - `BACKEND_CORS_ORIGINS` = `https://<your-vercel-url>.vercel.app`
     (set after step 2 — come back and update)
   - `TWELVE_DATA_API_KEY` = optional but **recommended** (faster than yfinance,
     free at twelvedata.com)
5. Redeploy. Confirm: `https://<service>.onrender.com/healthz` returns
   `{"ok": true}` and `/docs` shows Swagger UI with 28 endpoints.

**Note on free tier:** Render's free instance sleeps after 15 min of
inactivity (~30s cold start). Fine for demos; upgrade to the $7/mo Starter
when you have users.

## 2. Deploy the frontend (Vercel — ~3 min)

1. **vercel.com** → sign in with GitHub → **Add New → Project** →
   import `sehejsharm/Financial-Terminal`.
2. Vercel reads `vercel.json` and auto-configures:
   - Framework: **Next.js**
   - Root directory: **`frontend/`**
   - Build command: `cd frontend && npm install && npm run build`
3. **Environment Variables** (in the import screen):
   - `NEXT_PUBLIC_API_URL` = `https://<your-render-service>.onrender.com`
4. **Deploy**. Your live URL is `https://<project>.vercel.app`.
5. Go back to Render → set `BACKEND_CORS_ORIGINS` to that URL → redeploy
   backend.

## 3. First sign-in

Open the Vercel URL → login screen → use the `MOTHERBOARD_ADMIN_USER` /
`MOTHERBOARD_ADMIN_PASSWORD` you set on Render.

You'll land on the Dashboard. Cmd/Ctrl+K opens the command palette.

## 4. Share the app

- Vercel URL works for anyone — but they hit the login screen. Add users
  via the API (`POST /api/v1/admin/users`) or temporarily through the
  Streamlit Admin page; both write to the same store on the backend.
- Custom domain (optional): Vercel → Project → **Domains** → add yours,
  set the CNAME they show.

## Updating after a push

- Backend: Render auto-deploys when you push to the branch it's tracking.
- Frontend: Vercel auto-deploys every push (Preview URL for branches,
  Production URL for `main`).

## Trouble?

| Symptom | Likely cause | Fix |
|---|---|---|
| Login spinner stuck | CORS blocking the browser call | Set `BACKEND_CORS_ORIGINS` to the exact Vercel URL (with https:// , no trailing slash) and redeploy. |
| 401 on every call | Token expired (12 h default) | Log out and back in. Or raise `BACKEND_JWT_TTL_MIN`. |
| Snapshot quotes blank | Yahoo blocked the Render IP | Add `TWELVE_DATA_API_KEY` (much more reliable from cloud IPs). |
| Backend sleeps & first call is slow | Render free tier cold start | Upgrade to Starter, or add a cron pinger to `/healthz`. |
