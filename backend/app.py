"""FastAPI app — versioned /api/v1 + OpenAPI docs + audit middleware.

Run locally:
    uvicorn backend.app:app --reload --port 8000

Then visit:
    http://localhost:8000/docs        Swagger UI / OpenAPI
    http://localhost:8000/redoc       ReDoc

Auth: POST /api/v1/auth/login → bearer token → use on every other endpoint.
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import threading
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# Global backstop: any library that opens a socket without an explicit timeout
# (fredapi/urllib-style code, some yfinance paths) inherits this instead of
# blocking forever. A single unbounded upstream call once hung enough worker
# threads to take down /healthz and login on the 1-vCPU VM.
socket.setdefaulttimeout(20)
from fastapi.middleware.cors import CORSMiddleware

from backend.audit import AuditMiddleware
from backend.ratelimit import RateLimitMiddleware
from backend.config import CORS_ORIGINS
from backend.routes import (
    admin,
    ai,
    alerts,
    auth,
    data_api,
    deals,
    fundamentals,
    health,
    macro,
    market,
    notes,
    options,
    portfolio,
    screens,
    stream,
    value_chain,
    watchlists,
    workspaces,
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

# ── error monitoring ──────────────────────────────────────────────────────
# Optional Sentry: set SENTRY_DSN (and `pip install sentry-sdk`) to stream
# unhandled exceptions to Sentry's free tier. Without it, the structured
# exception handler below still logs every silent failure to the journal.
_log = logging.getLogger("motherboard.app")
if (os.getenv("SENTRY_DSN") or "").strip():
    try:
        import sentry_sdk
        sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], traces_sample_rate=0.0)
        _log.info("Sentry error monitoring enabled")
    except ImportError:
        _log.warning("SENTRY_DSN set but sentry-sdk not installed — "
                     "add it to requirements to enable Sentry")


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    """Every unhandled exception gets logged with route context so silent
    failures show up in `journalctl`/docker logs instead of vanishing."""
    _log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500,
                        content={"detail": "Internal error — logged."})


# Starlette nests middleware with the LAST added outermost. Desired nesting:
# CORS (outermost — 429s still get CORS headers so the browser can read the
# error) ⊃ Audit (429s appear in the audit log) ⊃ RateLimit ⊃ routes.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(AuditMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,  # cache CORS preflight 10 min -> far fewer OPTIONS round-trips
)

# Unversioned health
app.include_router(health.router)

# Versioned API
_V1 = "/api/v1"
for r in (auth.router, market.router, fundamentals.router, screens.router,
          options.router, value_chain.router, ai.router, watchlists.router,
          macro.router, deals.router, admin.router, portfolio.router,
          alerts.router, notes.router, workspaces.router, stream.router,
          data_api.router):
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
def _sync_admin() -> None:
    """deploy/.env is the source of truth for the master-admin credentials —
    re-synced on every boot so a password change in .env + restart is all a
    lockout recovery takes."""
    try:
        from lib.auth import ensure_env_admin
        ensure_env_admin()
    except Exception:
        pass


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

    def _alerts() -> None:
        from backend.routes import alerts as alerts_routes
        time.sleep(45)  # let providers warm before the first pass
        interval = int(os.getenv("ALERT_EVAL_SEC", "60") or 60)
        while True:
            try:
                alerts_routes.evaluate_all()
            except Exception:
                pass
            time.sleep(max(30, interval))

    def _slow() -> None:
        from backend.routes import screens as screens_routes
        # Delay the first scan so boot (movers + quotes + TLS issuance) isn't
        # competing with a 70-name fetch on 1 vCPU. PREWARM_SCAN_SEC=0
        # disables scan prewarming entirely (first screener call then pays it).
        interval = int(os.getenv("PREWARM_SCAN_SEC", "540") or 0)
        if interval <= 0:
            return
        time.sleep(90)
        while True:
            try:
                screens_routes._scan_cached.refresh()
            except Exception:
                pass
            time.sleep(interval)

    threading.Thread(target=_fast, daemon=True, name="prewarm-fast").start()
    threading.Thread(target=_slow, daemon=True, name="prewarm-slow").start()
    threading.Thread(target=_alerts, daemon=True, name="alert-eval").start()


@app.on_event("startup")
async def _start_stream_ingest() -> None:
    """Coalesced market-data poller for the /stream fan-out. Runs as an
    asyncio task (not a thread) — it needs the event loop the WebSocket
    connections live on. Idle (near-zero cost) until a client subscribes."""
    from backend.stream import ingest
    asyncio.create_task(ingest.run())
