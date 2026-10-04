# BASELINE — Phase 0

Recorded 2026-10-04, against commit `e018f85` on `claude/stock-market-dashboard-2BBMA`.

Everything in the ten-week plan is measured against this file. Where a number
could not be measured from the development sandbox, that is stated rather than
estimated. Nothing here is a guess dressed as a reading.

---

## 0. How these numbers were produced, and what they are worth

The sandbox this was recorded in cannot reach the data providers or the
production API host. `sehejmotherboard.duckdns.org` returns nothing; so do
Yahoo, NSE, FRED and Twelve Data. Package registries work, which is why the
build numbers are real.

So the request counts below were taken against the **whole stack running
locally** — this repo's FastAPI backend on `127.0.0.1:8000`, the production
Next build on `:4600`, a real login, and Chromium driving the dashboard. That
is a faithful measurement of **client behaviour**: how many requests the
front end issues, to which paths, carrying what. It is not a measurement of
**provider latency**, because there are no providers behind it.

The distinction matters more than it looks. The request fan-out is a property
of the client and reproduces exactly. The 8–11 second quote latencies in the
external review are a property of the upstream path and do not reproduce here
at all. Both are real; only one of them is in this file.

Reproduce with:

```bash
# backend
MB_DATA_DIR=/tmp/baseline-data \
MOTHERBOARD_ADMIN_USER=baseline MOTHERBOARD_ADMIN_PASSWORD='baseline-pw-123456' \
BACKEND_JWT_SECRET='baseline-secret-at-least-32-bytes-long-aaaaaaaa' \
BACKEND_CORS_ORIGINS='http://localhost:4600' \
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000

# frontend (NEXT_PUBLIC_API_URL defaults to http://localhost:8000)
cd frontend && npm run build && npx next start -p 4600
```

then drive it with Playwright and count `page.on('request')`.

**Still outstanding and only you can take it:** production p50/p95 per
endpoint, under a cold cache, from a machine that can reach the API host.
Until that exists, the Phase 1 target of "p95 quote latency under 800 ms" has
no "before" to beat.

---

## 1. Repo map

### Route tree

22 routes, all under `frontend/src/app`. Every page is `"use client"`; each
carries a thin server-component `layout.tsx` that exists only to supply the
page title and `og:url`. There is no server-side data fetching anywhere in the
app — every number on every screen is fetched from the browser after hydration.

| Route | Purpose |
|---|---|
| `/` | Dashboard — the 41-tile board |
| `/terminal` | Per-instrument terminal (function codes) |
| `/screeners` `/quant` `/workspace` `/portfolio` | The four working analysis surfaces |
| `/global` `/macro` `/news` `/sharks` | The four slow pages |
| `/alerts` `/account` `/admin` | Account + ops |
| `/login` `/privacy` `/terms` `/tearsheet` | Public / auxiliary |

### Where data fetching happens

Three mechanisms, and they do not share a cache:

1. **`frontend/src/lib/api.ts`** — one `apiFetch` wrapper around `fetch`.
   Attaches the bearer token, owns a small localStorage GET cache with
   per-prefix TTLs, and throws `ApiError` carrying a `serverFault` flag.
2. **`frontend/src/lib/quoteStore.ts`** — a module-level singleton holding one
   WebSocket for the whole app, ref-counted per-symbol subscriptions, an SSE
   fallback, and a REST "seed" so a cell paints before the first tick arrives.
3. **`useAsync` / `useLive`** — per-panel fetch state machines. `useAsync`
   already has a timeout and a retry; `useLive` polls on an interval.

### Where state lives

There is no global state manager. State is: React local state, the
`quoteStore` singleton, and localStorage. Keys written today:
`mb_theme`, `mb_cb`, `mb_chart_config`, `mb_quant_input`, `mb_quant_bench`,
`mb_recent_tickers`, `mb_alerts_seen`, `mb_passkey_primary`, plus the
`mb_cache_v1:` response cache and a dashboard layout blob.

### Auth

Bearer JWT, minted by `backend/auth.py:issue_token`, 12-hour TTL
(`BACKEND_JWT_TTL_MIN`, default 720), **no refresh token**. The client holds it
in a cookie written by non-HttpOnly JavaScript (`token.set` in `api.ts`) and
replays it as an `Authorization` header. Passkeys (WebAuthn) are a supplement,
never a replacement — password login always works.

`Shell.tsx` boots the session by calling `/auth/me` and only logs out on a real
401/403; a timeout is retried with backoff rather than treated as a rejection.

Middleware on the FastAPI app includes a per-IP sliding-window rate limiter
(`backend/ratelimit.py`), keyed by the matched rule prefix. **The API sets no
security response headers today** — that is Phase 2's starting point.

---

## 2. Call sites of the five endpoints

Every API call in the product goes through `api.ts`; **no component calls
`fetch` directly**. That is the one thing that makes the Phase 1 coalescer
tractable — there is exactly one chokepoint to put it behind.

| Endpoint | Defined at | Reached from |
|---|---|---|
| `/market/quote-bulk` | `api.ts:571` | **only** `quoteStore.seed()` (`quoteStore.ts:280`) |
| `/market/movers` | `api.ts:588` | `dashboard/MoversBoard.tsx` |
| `/watchlists` | `api.ts:722-732` | `dashboard/WatchlistBoard.tsx`, `Shell.tsx` (bell) |
| `/alerts`, `/alerts/events` | `api.ts:769-779` | `app/alerts/page.tsx`, `Shell.tsx` (bell poll, 60 s) |
| `/auth/*` | `api.ts:527-544` | `app/login/page.tsx`, `Shell.tsx`, `PasskeyManager.tsx` |

`quote-bulk` is today a **GET with a comma-separated query string**
(`?symbols=A,B,C`), signature `backend/routes/market.py:67`. Phase 1 moves it
to POST with a body.

---

## 3. Environment variables

**Frontend — one.** `NEXT_PUBLIC_API_URL`, read at `api.ts:11`, defaulting to
`http://localhost:8000`. It is inlined at build time, so the deployed bundle
hard-codes whichever host was set when Vercel built it.

**Backend — 21.**

| Group | Variables |
|---|---|
| Auth | `BACKEND_JWT_SECRET`, `BACKEND_JWT_TTL_MIN`, `MOTHERBOARD_ADMIN_USER`, `MOTHERBOARD_ADMIN_PASSWORD` |
| Passkeys | `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGINS` |
| Providers | `FMP_API_KEY`, `FRED_API_KEY`, `TWELVE_DATA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY` |
| Infra | `REDIS_URL`, `MB_DATA_DIR`, `BACKEND_CORS_ORIGINS`, `SENTRY_DSN`, `APP_VERSION` |
| Tuning | `MB_REQUEST_DEADLINE_S`, `ALERT_EVAL_SEC`, `PREWARM_SCAN_SEC`, `SCAN_WORKERS` |

Two notes. `SENTRY_DSN` is already read but nothing initialises Sentry — the
variable is a stub. `BACKEND_CORS_ORIGINS` defaults to
`http://localhost:3000,http://localhost:8501` when unset, which is a
development default shipping in a production code path.

---

## 4. Baseline measurements

### 4.1 Bundle size per route

Real, from `next build`. Shared baseline is **87.1 kB**.

| Route | Route JS | First Load JS |
|---|---|---|
| `/workspace` | 10.2 kB | **347 kB** |
| `/terminal` | 15 kB | **334 kB** |
| `/quant` | 11.7 kB | 207 kB |
| `/portfolio` | 16.5 kB | 198 kB |
| `/news` | 1.37 kB | 191 kB |
| `/macro` | 8.86 kB | 191 kB |
| `/alerts` | 8.31 kB | 190 kB |
| `/sharks` | 7.2 kB | 189 kB |
| `/` | 11.1 kB | 188 kB |
| `/global` | 10.8 kB | 180 kB |
| `/screeners` | 8.14 kB | 177 kB |
| `/admin` | 6.52 kB | 176 kB |
| `/account` | 2.82 kB | 172 kB |
| `/tearsheet` | 3.98 kB | 102 kB |
| `/login` | 3.36 kB | 94.5 kB |
| `/privacy`, `/terms` | 181 B | 94.1 kB |

`/news` is the interesting row: 1.37 kB of its own code and 191 kB to load it.
Whatever it costs, it is not the page.

### 4.2 Requests on one dashboard load

Measured locally, signed in, from navigation to twelve seconds after load.

| Metric | Measured | External review (production) |
|---|---|---|
| Total requests | 105 | 113 |
| To the API host | **45** | 68 |
| …of which `quote-bulk` | **40** | 62 |
| API requests in first 1.5 s | **45 (all of them)** | 41 |
| RSC prefetch requests | **36** | ~45 |

The local figures run below production because, with no upstream, the polling
and refetch paths that keep firing in production stop after the first failure.
The shape is identical and the mechanism is the same.

**The finding that matters:**

```
quote-bulk calls:                    40
symbols carried per call:            1   (all 40 of them)
total symbols actually requested:    40
```

Forty HTTP round trips to fetch forty quotes, through an endpoint named
*bulk*. It is bulk-capable; nobody calls it in bulk.

### 4.3 Endpoint latency — app-code floor only

With no provider reachable, these are the cost of the app's own code paths.
Treat them as a floor, not a baseline. Production numbers are still owed.

| Endpoint | p50 | p95 | status |
|---|---|---|---|
| `/screens/fields` | **40,038 ms** | **40,040 ms** | 200 |
| `/market/quote/{t}` | 183 ms | 264 ms | 404 |
| everything else measured | 2–4 ms | 2–4 ms | 200/422/503 |

`/screens/fields` blocks for forty seconds with no network involved at all. It
calls `_scan_cached()` (`backend/routes/screens.py:155`), which runs the full
universe scan synchronously on the request path. That is not provider latency;
that is a screener scan sitting in front of a field list.

---

## 5. What this says about Phase 1

Four things, in the order they should be fixed.

**The fan-out is a seeding bug, not an endpoint bug.** `subscribe()`
(`quoteStore.ts:86`) calls `this.seed(fresh)` immediately, per call, with no
batching. `useQuote(symbol)` subscribes one symbol per cell
(`useQuote.ts:17`), so each tile that mounts issues its own single-symbol
request. The page-level `useQuotes(symbols)` bulk subscription exists and is
correct — but React runs child effects before parent effects, so forty tiles
have already each seeded themselves by the time the parent's bulk subscription
runs and finds nothing fresh left to seed. The coalescer belongs inside
`seed()`: collect across a 50 ms window, issue one call, fan out.

**The shared-socket footnote is true and should be kept.** There is one
WebSocket for the whole app, ref-counted per symbol, with an SSE fallback. The
copy claiming "41 instruments subscribed on one shared socket" is accurate.
The REST seed is what is wrong, not the socket.

**The prefetch storm is real** — 36 RSC prefetches nobody asked for.

**`/screens/fields` is the first server-side cache target**, ahead of anything
provider-related, because it is forty seconds of our own making.

---

## 6. Known gaps in this baseline

- Production p50/p95 per endpoint under cold cache. Needs a run from a host
  that can reach the API.
- Lighthouse scores. Needs a deployed URL.
- `/global`'s "0/20 tiles priced" state. Needs real providers to reproduce;
  locally everything is unpriced for a different reason.
- The external review's 8–11 s quote latencies. Upstream-path property, not
  reproducible here.
