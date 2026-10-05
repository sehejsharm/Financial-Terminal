"""A ceiling on request body size.

There was none anywhere in the stack: no uvicorn flag, no `request_body
{ max_size }` in the Caddyfile, no check in the app. So every POST and PUT
accepted an arbitrarily large body. On a container capped at 768 MB
(deploy/docker-compose.yml) that is a one-request restart loop, and the
endpoints that persist to the mounted volume — PUT /notes/{ticker},
/workspaces, POST /portfolio/import — were an unbounded write to the disk the
user database lives on.

Two checks, because either alone is bypassable:

  * Content-Length, when declared, is rejected before a single byte of body is
    read. This is the cheap path and covers an honest client.
  * The stream is then counted as it is consumed, which is what catches a
    chunked request that declares no length at all. Without this, omitting
    Content-Length skips the limit entirely.

The limit is per-route-shaped rather than global: a portfolio CSV import is
legitimately a few hundred kilobytes, while a notes PUT or a login body has no
business exceeding a few. One global ceiling would have to be the largest of
those, which would leave the small endpoints as wide open as before.
"""
from __future__ import annotations

import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

_KB = 1024

# Default for anything not listed. Generous enough for any JSON payload the
# front end sends, small enough that it is not a memory event.
DEFAULT_MAX_BODY = int(os.getenv("MAX_BODY_BYTES", str(256 * _KB)))

# (prefix, max bytes). First match wins, so specific prefixes come first.
BODY_LIMITS: list[tuple[str, int]] = [
    # The one genuinely large upload in the product: a broker CSV/statement.
    # A 5 MB file is tens of thousands of rows, well past any retail book.
    ("/api/v1/portfolio/import", 5 * 1024 * _KB),
    # Free-text research notes. Long, but prose.
    ("/api/v1/notes", 512 * _KB),
    # A saved workspace is layout JSON.
    ("/api/v1/workspaces", 512 * _KB),
    # A prompt plus context. Bounded on the provider side anyway, and every
    # byte here is a byte we pay a vendor to tokenize.
    ("/api/v1/ai", 128 * _KB),
    # A screen definition is a handful of predicates.
    ("/api/v1/screens", 64 * _KB),
    # Credentials and WebAuthn ceremonies: fixed, tiny shapes. A large body
    # here is never legitimate.
    ("/api/v1/auth", 16 * _KB),
]


def limit_for(path: str) -> int:
    for prefix, cap in BODY_LIMITS:
        if path.startswith(prefix):
            return cap
    return DEFAULT_MAX_BODY


def _too_large(cap: int) -> JSONResponse:
    # 413 with the ceiling stated. A client that gets a bare error here has no
    # way to know whether to retry smaller or give up.
    return JSONResponse(
        status_code=413,
        content={"detail": f"Request body too large — limit is {cap} bytes."},
    )


class BodyLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method in ("GET", "HEAD", "OPTIONS", "DELETE"):
            return await call_next(request)

        cap = limit_for(request.url.path)

        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                if int(declared) > cap:
                    return _too_large(cap)
            except ValueError:
                # A malformed Content-Length is not something to interpret
                # generously; the streaming guard below still applies.
                pass

        # Count the body as the route consumes it. Replacing the receive
        # channel rather than calling request.body() matters: reading the body
        # here would buffer the whole thing in memory — precisely the problem
        # — and would also consume the stream the route still needs.
        seen = 0
        over = False
        original = request.receive

        async def counted():
            nonlocal seen, over
            message = await original()
            if message.get("type") == "http.request":
                seen += len(message.get("body", b""))
                if seen > cap:
                    over = True
                    # Hand the route a truncated, terminated stream. It will
                    # fail its own parse; the 413 below is what the client
                    # actually sees.
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        request._receive = counted  # type: ignore[attr-defined]
        response = await call_next(request)
        if over:
            return _too_large(cap)
        return response
