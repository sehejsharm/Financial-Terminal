# Motherboard Frontend (Next.js)

Next.js 14 (App Router) + TypeScript + Tailwind. Designed to feel like a
real terminal: dark amber theme, monospace numerics, dense data tables,
keyboard-first navigation (Cmd/Ctrl+K command palette), TradingView
Lightweight Charts.

Talks to the FastAPI backend in `backend/` — there is **no Python in this
app**. Backend deploys separately (Render/Fly), frontend deploys to Vercel.

## Local dev

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
# open http://localhost:3000
```

Make sure the backend is running on :8000 first (`uvicorn backend.app:app`).

## Pages

| Path          | What it does                                                       |
|---------------|--------------------------------------------------------------------|
| `/login`      | JWT auth against `POST /api/v1/auth/login`. Cookie-stored token.   |
| `/`           | Market snapshot grid (uses `/market/quote-bulk` for speed) + watchlists. |
| `/terminal`   | Single-name workhorse: ticker + function dropdown, TradingView chart. |
| `/screeners`  | Preset screens with one-click open-in-Terminal per row.            |

`Cmd/Ctrl+K` anywhere → command palette for ticker search + page jump.

## Deploy on Vercel

The repo includes a root-level `vercel.json` pointing Vercel at this
directory. Two ways:

### A. Dashboard (easiest)
1. vercel.com → **Add New → Project** → import `sehejsharm/Financial-Terminal`.
2. Vercel picks up `vercel.json` automatically (Next.js, root = `frontend`).
3. Set Environment Variable:
   - `NEXT_PUBLIC_API_URL` = your live backend URL (e.g. `https://motherboard-api.onrender.com`)
4. Deploy. Vercel auto-deploys on every push to `main` afterwards.

### B. CLI
```bash
npm i -g vercel
vercel link            # connect to a Vercel project
vercel env add NEXT_PUBLIC_API_URL production
vercel --prod
```

## Why this layout

- **Server-rendered Next.js** swaps Streamlit's "re-run the whole script
  on every interaction" model for client-side state + targeted refetches.
  Page loads are sub-second; widgets don't blink on every keystroke.
- **TanStack/cmdk/lightweight-charts** instead of widget libraries —
  enterprise look without paying for a chart license.
- **Component-first**: every metric/chart/table is a reusable component,
  not a page-level Streamlit call. Adding a new function to the Terminal
  page is ~30 lines, not a new file.

## What's not built yet

This is a scaffold proving the pattern; full feature parity with the
Streamlit Terminal is incremental work. Easy wins next:
- Financials view → call `/api/v1/fundamentals/{ticker}/statement/{kind}`
- Options chain table → `/api/v1/options/{ticker}/chain`
- Value-chain map → `/api/v1/value-chain/{ticker}` + a node-graph lib
- Watchlist editor (create/delete UI; API endpoints exist)
- AI deep-dive panel → `/api/v1/ai/bull-bear`
