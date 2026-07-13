"""FastAPI app — versioned /api/v1 + OpenAPI docs + audit middleware.

Run locally:
    uvicorn backend.app:app --reload --port 8000

Then visit:
    http://localhost:8000/docs        Swagger UI / OpenAPI
    http://localhost:8000/redoc       ReDoc

Auth: POST /api/v1/auth/login → bearer token → use on every other endpoint.
"""
from __future__ import annotations

import threading
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.audit import AuditMiddleware
from backend.config import CORS_ORIGINS
from backend.routes import (
    admin,
    ai,
    auth,
    deals,
    fundamentals,
    health,
    macro,
    market,
    options,
    screens,
    value_chain,
    watchlists,
)

app = FastAPI(
    title="Motherboard API",
    version="0.1.0",
    description=(
        "Educational research API extracted from the Streamlit prototype. "
        "All financial figures are advisory only and not investment advice."
    ),
    openapi_url="/openapi.json",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,  # cache CORS preflight 10 min -> far fewer OPTIONS round-trips
)
app.add_middleware(AuditMiddleware)

# Unversioned health
app.include_router(health.router)

# Versioned API
_V1 = "/api/v1"
for r in (auth.router, market.router, fundamentals.router, screens.router,
          options.router, value_chain.router, ai.router, watchlists.router,
          macro.router, deals.router, admin.router):
    app.include_router(r, prefix=_V1)


# Must match the dashboard's SNAPSHOT_TICKERS (frontend/src/app/page.tsx) after
# the route's normalization (sorted, deduped) so the prewarmer writes the exact
# cache entry user requests read.
_DASH_TICKERS = tuple(sorted({
    "^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX",
    "^CNXIT", "^CNXFMCG", "^CNXAUTO", "^CNXPHARMA",
    "^CNXMETAL", "^CNXENERGY", "^CNXMIDCAP", "^CNX500",
}))


@app.on_event("startup")
def _prewarm() -> None:
    """Background cache prewarmer.

    Two daemon loops keep the hot read paths warm so user requests are served
    from cache (<10 ms + JSON) instead of paying live provider round-trips:

      fast loop  — dashboard index quotes every 25 s (cache TTL 30 s) and
                   NIFTY movers every 240 s (TTL 300 s). NSE-direct only:
                   ~0.5 req/s average, no metered API involved.
      slow loop  — the ~70-name screener universe scan every 540 s (TTL
                   600 s). Runs on its own thread because a scan takes
                   seconds and must not delay quote refreshes. quota_safe:
                   never touches FMP / Twelve Data.

    First iterations double as the original one-shot warm-up (imports + NSE
    cookie session). Everything is best-effort: errors are swallowed and the
    loops keep going.
    """

    def _fast() -> None:
        from backend.routes import market
        tick = 0
        while True:
            try:
                market._bulk_quotes.refresh(_DASH_TICKERS)
            except Exception:
                pass
            if tick % 10 == 0:  # every ~250 s, under the 300 s movers TTL
                for kind in ("gainers", "losers"):
                    try:
                        market._movers.refresh(kind, 8)
                    except Exception:
                        pass
            tick += 1
            time.sleep(25)

    def _slow() -> None:
        from backend.routes import screens as screens_routes
        while True:
            try:
                screens_routes._scan_cached.refresh()
            except Exception:
                pass
            time.sleep(540)

    threading.Thread(target=_fast, daemon=True, name="prewarm-fast").start()
    threading.Thread(target=_slow, daemon=True, name="prewarm-slow").start()
