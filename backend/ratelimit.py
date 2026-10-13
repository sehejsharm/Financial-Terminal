"""Per-IP sliding-window rate limiting (in-memory).

Targets the abuse-sensitive routes: credential guessing on /auth/login,
alert/write spam, and admin endpoints. Normal read traffic is untouched.
Single-process only (matches the single-VM deploy); a Redis-backed limiter
can replace this when the app scales out.

Three things here are easy to get wrong and all three were, so they are
spelled out:

  1. WHOSE IP. See `client_ip`. Behind a reverse proxy, `request.client.host`
     is the proxy, so every rule degenerates into one shared global bucket.
  2. WHAT IS COVERED. `_RULES` is first-prefix-wins, so order matters and the
     catch-all must come last. Anything not matched is unlimited.
  3. WHICH PROTOCOL. `RateLimitMiddleware` is `BaseHTTPMiddleware`-shaped, so
     it only ever sees scopes of type "http". A WebSocket upgrade does not go
     through it at all, which is why the socket handshake has to ask for its
     ceiling itself — see `allow_ws_handshake` and routes/stream.py.
"""
from __future__ import annotations

import ipaddress
import os
import threading
import time

from starlette.middleware.base import BaseHTTPMiddleware
# HTTPConnection is the common base of Request and WebSocket, and it is the
# honest type for `client_ip`: the function needs .client and .headers, which
# both halves of that pair have. Annotating it `Request` is what made a second
# idea of "who is this" look necessary for the socket path.
from starlette.requests import HTTPConnection, Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

# How many reverse proxies sit in front of this process. 0 (the default) means
# "none — ignore X-Forwarded-For entirely", which is the fail-safe: an app
# reachable directly must never let a caller nominate its own bucket key.
# The production deploy runs behind exactly one Caddy hop and sets this to 1
# (deploy/docker-compose.yml). See `client_ip` for why the count is what
# matters rather than a list of proxy addresses.
TRUSTED_PROXY_HOPS = int(os.getenv("TRUSTED_PROXY_HOPS", "0") or 0)

# The /auth/login ceiling, per client per minute. Configurable for ONE reason:
# the end-to-end suite signs in once per test and runs far more than ten tests
# a minute, so a fixed ten makes the suite fail on its own throttle rather than
# on a defect.
#
# The default is the strict value and must stay that way — this is the
# brute-force guard. A production deploy should never set it. It is honoured
# per-client (see client_ip), so raising it does NOT make a shared bucket
# again; it only widens how fast one address may guess.
LOGIN_RATE_PER_MIN = int(os.getenv("BACKEND_LOGIN_RATE_PER_MIN", "10") or 10)

# WebSocket handshakes to /api/v1/stream, per client per minute.
#
# Why this number is large. The browser client retries a dropped socket with
# `min(30s, 1000ms * 2**failures) * jitter(0.7..1.3)` and resets `failures` to
# 0 on every successful open (frontend/src/lib/quoteStore.ts), so a socket that
# opens and dies immediately — the normal shape of a flaky mobile link, a
# train tunnel, a laptop waking — retries on the ~1 s floor indefinitely:
# roughly 60 handshakes a minute from ONE tab. Several tabs multiply it, and a
# carrier NAT puts many unrelated users on one address, which is the only
# identity we have. 600 leaves an order of magnitude over one tab's worst
# legitimate case; a ceiling a real user reaches is an outage, not a control,
# and the user-visible cost of being wrong here is the terminal going dark on
# live prices.
#
# It is still a real bound: it turns an unlimited flood into 10 attempts a
# second per address, and a refused attempt is decided before the token is
# decoded, so it costs a dict lookup rather than a signature verification.
#
# Unlike LOGIN_RATE_PER_MIN, the DEFAULT here is the loose value and the env
# var exists to tighten it — an operator watching a flood can cut it without a
# deploy. That asymmetry is deliberate: the risk of a wrong login ceiling is a
# wider brute-force window, the risk of a wrong handshake ceiling is locking
# real users out of the data plane.
WS_HANDSHAKE_RATE_PER_MIN = int(
    os.getenv("BACKEND_WS_HANDSHAKE_RATE_PER_MIN", "600") or 600)

# (prefix, methods or None for all) -> (max requests, window seconds)
#
# FIRST MATCH WINS, so specific prefixes must precede the general ones and the
# /api/v1 backstop must stay at the bottom. Ceilings are set well above what
# the app itself generates — a limit a real user can reach is an outage, not a
# control — and tightest where a request costs us money (metered providers,
# LLM tokens) or where guessing is the attack (credentials).
_RULES: list[tuple[str, frozenset[str] | None, int, int]] = [
    ("/api/v1/auth/login", None, LOGIN_RATE_PER_MIN, 60),  # brute-force guard
    # Passkey ceremonies are two POSTs each and a failed biometric is a normal
    # thing to retry, so this is looser than the password rule. It is a
    # separate bucket: exhausting it must never block the password fallback.
    # An assertion cannot be brute-forced (it needs a valid signature), so the
    # ceiling here is really about capping challenge minting.
    ("/api/v1/auth/passkey", None, 40, 60),
    # Invite and reset links are guessed by trying tokens, and the
    # forgot-password endpoint is public and sends mail — so it is also a way
    # to use this app to spam a third party. Tight on both counts.
    ("/api/v1/auth/invite", None, 20, 60),
    ("/api/v1/auth/forgot-password", None, 5, 60),
    # Public, writes to the data volume and sends mail. Someone with a real
    # complaint files one; five a minute is well past that and short of being
    # a way to fill the disk or mail-bomb an address.
    ("/api/v1/support", None, 5, 60),
    ("/api/v1/alerts", frozenset({"POST", "PUT", "DELETE"}), 30, 60),
    ("/api/v1/admin", None, 60, 60),
    ("/api/v1/ai", frozenset({"POST"}), 20, 60),   # LLM calls cost quota
    # GET /ai/provider is a cheap config read, but it fell outside the POST
    # rule above and so had no ceiling at all.
    ("/api/v1/ai", None, 60, 60),
    # Market reads are authenticated, so the anonymous requests seen in the
    # audit log were already being rejected with 401 — this is defence in
    # depth, not a fix for an open endpoint. The ceiling is well above what
    # the app itself generates: the dashboard batches its symbols into one
    # quote-bulk call every few seconds, nowhere near 240/min. Covers every
    # method, not just GET, because POST /market/quote-bulk — the single
    # highest-fan-out call in the product — is a POST and was uncovered.
    ("/api/v1/market", None, 240, 60),
    # The DAPI pair. These fan out to metered providers one ticker at a time
    # and authenticate with a token that may arrive in the query string, which
    # makes them the easiest thing here to point a script at.
    ("/api/v1/data", None, 120, 60),
    # Each screen is a scan over ~70 names against a paid provider. This is
    # the most expensive request in the app per call; 20/min is still far more
    # than a human clicking through screeners will ever issue.
    ("/api/v1/screens", None, 20, 60),
    # Provider-backed reads. One terminal page load issues a handful.
    ("/api/v1/fundamentals", None, 120, 60),
    ("/api/v1/options", None, 120, 60),
    ("/api/v1/value-chain", None, 120, 60),
    ("/api/v1/macro", None, 120, 60),
    ("/api/v1/deals", None, 120, 60),
    # User data on disk. The ceiling here is about capping writes to the
    # volume, not about provider cost.
    ("/api/v1/portfolio", None, 120, 60),
    ("/api/v1/watchlists", None, 120, 60),
    ("/api/v1/notes", None, 120, 60),
    ("/api/v1/workspaces", None, 120, 60),
    # SSE reconnects are normal on a flaky mobile connection, so this is
    # generous. NOTE: this still does nothing for the WebSocket at
    # /api/v1/stream — BaseHTTPMiddleware never runs for a WS handshake, so no
    # entry in this table can cover it. The socket is throttled by
    # `allow_ws_handshake`, which the handshake calls directly; that is a
    # SEPARATE bucket on purpose, because SSE is where a client goes when the
    # socket keeps failing and one failure must not spend both budgets.
    ("/api/v1/stream", None, 60, 60),
    # Backstop. Anything added under /api/v1 in future gets a ceiling by
    # default instead of silently getting none, which is how most of the list
    # above came to be missing in the first place.
    ("/api/v1", None, 600, 60),
]

_lock = threading.Lock()
_hits: dict[str, list[float]] = {}
_MAX_KEYS = 10_000


def _match(path: str, method: str) -> tuple[str, int, int] | None:
    """The first rule covering this request, and the prefix that matched.

    The prefix comes back because it, not the path, identifies the bucket —
    see `allow`.
    """
    for prefix, methods, limit, window in _RULES:
        if path.startswith(prefix) and (methods is None or method in methods):
            return prefix, limit, window
    return None


def client_ip(request: HTTPConnection) -> str:
    """The address to charge this request to.

    Takes an HTTPConnection, so this is the one answer for both halves of the
    app: a WebSocket handshake carries a .client peer and .headers exactly as
    an HTTP request does, and the socket path calls this rather than growing a
    second idea of who the caller is. Two implementations would drift, and the
    one that drifted would be the socket — it has no middleware watching it.

    `request.client.host` is the TCP peer. In production the only thing that
    can reach this process is Caddy on the compose bridge, so the peer is
    Caddy's container IP for 100% of traffic — which meant every rule above
    was one bucket shared by the entire internet. The practical effect was
    worse than no limit: ten login attempts a minute globally, so one script
    could hold the login endpoint shut for every real user while never being
    throttled per-attacker at all.

    X-Forwarded-For is attacker-controlled on the way in, so trusting the
    whole header just hands the bucket key to the caller. What is NOT
    attacker-controlled is the part our own proxy wrote: each hop APPENDS the
    peer it saw. With one trusted hop the real client is therefore the LAST
    entry, however many fake ones the caller prepended. With N hops the last
    N-1 are proxy addresses and the client is at -N.

    That is why this is a hop COUNT and not an allowlist of proxy addresses:
    the count is what tells us where in the chain the forgeable part stops,
    and Caddy's bridge address is assigned by Docker and changes.
    """
    peer = request.client.host if request.client else "unknown"
    if TRUSTED_PROXY_HOPS <= 0:
        return peer
    chain = [p.strip() for p in
             request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    # Fewer entries than the topology claims: the request did not come through
    # the proxies we think it did, so believe the socket instead of guessing.
    if len(chain) < TRUSTED_PROXY_HOPS:
        return peer
    candidate = chain[-TRUSTED_PROXY_HOPS]
    try:
        # A value that is not an address is not something a correct proxy
        # writes. Rejecting it also stops a junk chain from minting unbounded
        # distinct bucket keys.
        ipaddress.ip_address(candidate)
    except ValueError:
        return peer
    return candidate


def _evict_locked(now: float) -> None:
    """Drop buckets whose every timestamp has aged out. Caller holds _lock.

    This replaces a `_hits.clear()` backstop. Keying per real client instead
    of per proxy multiplies the key count, so the backstop stopped being
    theoretical — and clearing the whole table forgives every bucket at once,
    which fails open exactly when the table is full because someone is
    hammering it.
    """
    # Derived from _RULES, which does not list the WebSocket handshake bucket
    # — that one is fine here only because its window is also 60 s. If the
    # handshake window ever stops matching the longest rule window, this has
    # to take the max over both or it will evict a live socket bucket.
    longest = max(w for _, _, _, w in _RULES)
    dead = [k for k, stamps in _hits.items()
            if not stamps or now - stamps[-1] >= longest]
    for k in dead:
        del _hits[k]
    if len(_hits) > _MAX_KEYS:
        # Still full of live buckets. Shed the oldest rather than everything,
        # so the busiest (most recently seen) attackers keep their counters.
        for k in sorted(_hits, key=lambda k: _hits[k][-1])[:len(_hits) - _MAX_KEYS]:
            del _hits[k]


def _consume(key: str, limit: int, window: int) -> bool:
    """Charge one hit to `key`; False if that would exceed `limit` in `window`.

    The sliding window lives here rather than in `allow` so the WebSocket
    handshake shares exactly this accounting — including the eviction backstop
    and the lock. A second copy would be the one that quietly fails open.

    A refused hit is NOT recorded. That keeps a blocked caller from extending
    their own penalty indefinitely, and it is the behaviour the HTTP rules
    have always had.
    """
    now = time.time()
    with _lock:
        if len(_hits) > _MAX_KEYS:  # runaway-key backstop
            _evict_locked(now)
        stamps = [t for t in _hits.get(key, []) if now - t < window]
        if len(stamps) >= limit:
            _hits[key] = stamps
            return False
        stamps.append(now)
        _hits[key] = stamps
    return True


def allow(ip: str, path: str, method: str) -> bool:
    rule = _match(path, method)
    if rule is None:
        return True
    prefix, limit, window = rule
    # Bucket by the RULE that matched, not by a fixed path segment. Keying on
    # segment 3 made every path under /api/v1/auth share one counter, so the
    # two-request passkey ceremony would have spent the password-login budget
    # — locking a user out of the fallback that exists precisely for when the
    # passkey does not work. Rules are independent by construction now.
    return _consume(f"{ip}:{prefix}:{method}", limit, window)


def allow_ws_handshake(ip: str) -> bool:
    """Charge one WebSocket upgrade attempt to `ip`.

    Called by the handshake itself (routes/stream.py) because no middleware on
    this app ever sees a WS scope — see item 3 in the module docstring. Until
    this existed, /api/v1/stream was the one route in the app with no ceiling
    at all, and the one where a connection attempt is cheapest to generate.

    The key cannot collide with an HTTP bucket: those are
    "{ip}:{prefix}:{method}" and every prefix starts with "/".

    The ceiling is read here rather than captured at import so it can be
    tightened at runtime (and so a test can pin the behaviour without
    opening six hundred sockets).
    """
    return _consume(f"{ip}:ws-handshake", WS_HANDSHAKE_RATE_PER_MIN, 60)


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp):
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        if not allow(client_ip(request), request.url.path, request.method):
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests — slow down and retry "
                                   "in a minute."},
            )
        return await call_next(request)
