"""Audit-log middleware.

Records every API request: timestamp (UTC ISO), user (or 'anonymous'), IP,
method, path, status code, latency. Append-only JSONL via the Storage
interface — swappable to Postgres in Phase 4.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import jwt
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from backend.config import JWT_ALGO, get_jwt_secret
from backend.storage import get_storage

# Paths we don't bother auditing — health checks, OpenAPI docs.
_SKIP_PREFIXES = ("/healthz", "/docs", "/openapi.json", "/redoc", "/favicon")


def _username_from_request(request: Request) -> str:
    """Best-effort extract from a Bearer token. Never raises."""
    h = request.headers.get("authorization") or ""
    if not h.lower().startswith("bearer "):
        return "anonymous"
    token = h.split(" ", 1)[1].strip()
    try:
        claims = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGO])
        return claims.get("sub") or "anonymous"
    except Exception:
        return "anonymous"


class AuditMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp):
        super().__init__(app)
        self.storage = get_storage()

    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith(_SKIP_PREFIXES):
            return await call_next(request)

        started = time.perf_counter()
        status_code: int = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            event = {
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "user": _username_from_request(request),
                "ip": request.client.host if request.client else None,
                "method": request.method,
                "path": request.url.path,
                "query": str(request.url.query) or None,
                "status": status_code,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            }
            try:
                self.storage.append_audit(event)
            except Exception:
                # Audit failure must never break the request.
                pass
