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


@app.on_event("startup")
def _prewarm() -> None:
    """Best-effort warm-up so the first request doesn't pay import + network
    cold-start (yfinance/curl_cffi import, NSE session). Never blocks or
    crashes boot — runs on a daemon thread and swallows all errors."""

    def _run() -> None:
        try:
            from backend import providers
            providers.quotes_bulk(["^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX"])
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()
