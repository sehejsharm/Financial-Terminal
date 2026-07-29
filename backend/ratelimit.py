"""Per-IP sliding-window rate limiting (in-memory).

Targets the abuse-sensitive routes: credential guessing on /auth/login,
alert/write spam, and admin endpoints. Normal read traffic is untouched.
Single-process only (matches the single-VM deploy); a Redis-backed limiter
can replace this when the app scales out.
"""
from __future__ import annotations

import threading
import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

# (prefix, methods or None for all) -> (max requests, window seconds)
_RULES: list[tuple[str, frozenset[str] | None, int, int]] = [
    ("/api/v1/auth/login", None, 10, 60),          # brute-force guard
    ("/api/v1/alerts", frozenset({"POST", "PUT", "DELETE"}), 30, 60),
    ("/api/v1/admin", None, 60, 60),
    ("/api/v1/ai", frozenset({"POST"}), 20, 60),   # LLM calls cost quota
    # Market reads are authenticated, so the anonymous requests seen in the
    # audit log were already being rejected with 401 — this is defence in
    # depth, not a fix for an open endpoint. The ceiling is well above what
    # the app itself generates: the dashboard batches its symbols into one
    # quote-bulk call every few seconds, nowhere near 240/min.
    ("/api/v1/market", frozenset({"GET"}), 240, 60),
]

_lock = threading.Lock()
_hits: dict[str, list[float]] = {}
_MAX_KEYS = 10_000


def _match(path: str, method: str) -> tuple[int, int] | None:
    for prefix, methods, limit, window in _RULES:
        if path.startswith(prefix) and (methods is None or method in methods):
            return limit, window
    return None


def allow(ip: str, path: str, method: str) -> bool:
    rule = _match(path, method)
    if rule is None:
        return True
    limit, window = rule
    now = time.time()
    key = f"{ip}:{path.split('/')[3] if path.count('/') >= 3 else path}:{method}"
    with _lock:
        if len(_hits) > _MAX_KEYS:  # runaway-key backstop
            _hits.clear()
        stamps = [t for t in _hits.get(key, []) if now - t < window]
        if len(stamps) >= limit:
            _hits[key] = stamps
            return False
        stamps.append(now)
        _hits[key] = stamps
    return True


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp):
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        ip = request.client.host if request.client else "unknown"
        if not allow(ip, request.url.path, request.method):
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests — slow down and retry "
                                   "in a minute."},
            )
        return await call_next(request)
