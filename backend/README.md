# Motherboard API

FastAPI backend extracted from the Streamlit prototype per Phase 1 of
`docs/enterprise-migration-plan.md`. Reuses every module in `lib/` directly —
your business logic ported across as-is. Streamlit and the API can run
side-by-side and share the same user store / watchlists / audit log.

## Quick start (local, no Docker)

```bash
pip install -r requirements.txt -r requirements-backend.txt
uvicorn backend.app:app --reload --port 8000
```

Visit:

- http://localhost:8000/docs — Swagger UI (try every endpoint here)
- http://localhost:8000/redoc — ReDoc
- http://localhost:8000/openapi.json — raw schema

### Auth flow

```bash
# 1. Get a JWT (uses the same users.json the Streamlit app reads)
curl -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PW"}'
# → { "access_token": "...", "expires_at": "...", "role": "master_admin" }

# 2. Use it on every other request
TOKEN=...
curl http://localhost:8000/api/v1/market/quote/AAPL \
  -H "Authorization: Bearer $TOKEN"
```

## With Docker (Redis cache too)

```bash
cd backend
docker compose up --build
```

This brings up the API + Redis on the same network; the API picks up Redis
automatically via `REDIS_URL`.

## What's where

```
backend/
  app.py              FastAPI app, OpenAPI, middleware wiring
  config.py           Env-driven config (JWT secret, Redis URL, CORS)
  auth.py             JWT issuance + verification (built on lib/auth.py)
  audit.py            Middleware → data/audit.jsonl (append-only)
  cache.py            @cached decorator (Redis or in-process LRU)
  schemas.py          Pydantic request/response models
  storage/            Pluggable persistence (JSON today, Postgres-ready)
  routes/
    auth.py           POST /auth/login, GET /auth/me
    market.py         /market/{search,quote,history,snapshot,movers}
    fundamentals.py   /fundamentals/{ticker}/{statement,estimates,capital-structure}
    screens.py        Presets + Buffett + Graham + ETF + custom
    options.py        Expiries, chain, Greeks, max pain
    value_chain.py    SPLC-style structured map
    ai.py             Bull/bear, deep analysis (Groq / Gemini)
    watchlists.py     CRUD per user
    admin.py          User mgmt + audit log (master-admin only)
    health.py         /healthz, /version
```

## Environment

| Var                          | Default                  | Purpose                                                   |
|------------------------------|--------------------------|-----------------------------------------------------------|
| `BACKEND_JWT_SECRET`         | auto, persisted          | Sign/verify JWTs. **Set in prod** so tokens survive boot. |
| `BACKEND_JWT_TTL_MIN`        | `720`                    | Token lifetime in minutes (12 h default).                 |
| `REDIS_URL`                  | _(unset)_                | If unset, cache is in-process. `redis://host:6379/0`.     |
| `BACKEND_CORS_ORIGINS`       | localhost:3000,8501      | Comma-separated.                                          |
| `MOTHERBOARD_ADMIN_*`        | _(see lib/auth.py)_      | First-run seed (same as Streamlit).                       |
| `GROQ_API_KEY` / `GEMINI_*`  | _(unset)_                | AI provider (Groq preferred).                             |

## Auditing

Every authenticated request is logged to `data/audit.jsonl` (one JSON object
per line) via `AuditMiddleware`. Master admins can read the tail via
`GET /api/v1/admin/audit?limit=N`. Swap to Postgres in Phase 4 by writing a
second `Storage` implementation — no other code needs to change.

## Tests

```bash
pytest tests/test_backend.py -v
```

Covers happy-path login → token usage, watchlist CRUD round-trip, audit
trail capture, and admin-role gating.
