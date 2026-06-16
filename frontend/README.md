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

## Terminal functions (all wired to live endpoints)

The Terminal page's function dropdown covers, each against its backend route:
- **Snapshot** — quote + key metrics + 1-year chart
- **Technicals & charts** — period-switchable price chart (1M/6M/1Y/5Y)
- **Financials** — income / balance / cash-flow, annual or quarterly
  (`/fundamentals/{ticker}/statement/{kind}`)
- **Estimates & targets** — price targets + earnings/revenue/growth estimates
- **Capital structure** — debt/cash/equity stack + enterprise value bar
- **Value-chain map** — Bloomberg SPLC-style SVG node graph
  (suppliers → company → customers, competitors below)
- **Options & Greeks** — expiry selector, calls/puts with Black-Scholes
  Greeks + max-pain
- **AI deep-dive** — bull-vs-bear and deep-analysis (on-demand to respect quota)

Screeners covers PEG / Hidden Gems / Growth / Buffett Quality / Graham Value /
Top ETFs. The Dashboard has a full watchlist create/delete editor and a
gainers/losers movers panel.

## Not yet ported from Streamlit

A few single-purpose Streamlit views don't have backend endpoints yet
(Comparables, Debt profile, Ownership/insiders, Earnings history, Street
ratings, WACC model, Recent news). Add the route first, then a ~30-line
component — same pattern as the views above.
