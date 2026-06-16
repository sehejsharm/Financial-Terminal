"""FastAPI app — versioned /api/v1 + OpenAPI docs + audit middleware.

Run locally:
    uvicorn backend.app:app --reload --port 8000

Then visit:
    http://localhost:8000/docs        Swagger UI / OpenAPI
    http://localhost:8000/redoc       ReDoc

Auth: POST /api/v1/auth/login → bearer token → use on every other endpoint.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.audit import AuditMiddleware
from backend.config import CORS_ORIGINS
from backend.routes import (
    admin,
    ai,
    auth,
    fundamentals,
    health,
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
)
app.add_middleware(AuditMiddleware)

# Unversioned health
app.include_router(health.router)

# Versioned API
_V1 = "/api/v1"
for r in (auth.router, market.router, fundamentals.router, screens.router,
          options.router, value_chain.router, ai.router, watchlists.router,
          admin.router):
    app.include_router(r, prefix=_V1)
