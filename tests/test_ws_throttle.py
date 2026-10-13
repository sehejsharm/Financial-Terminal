"""The /api/v1/stream WebSocket handshake had no ceiling.

`RateLimitMiddleware` is `BaseHTTPMiddleware`-shaped, so it never runs for a
WS upgrade: every HTTP route had a per-client limit and the socket handshake
had none, so connection attempts to /api/v1/stream could be flooded and
nothing counted them.

These tests pin the throttle where it now lives — inside the handshake — and,
just as importantly, pin the two ways the fix could end up worse than the bug
it closes:

  * Throttling a real client. A dropped socket is retried with backoff that
    floors at ~1 s, and `quoteStore` resets its failure counter on every
    successful open (frontend/src/lib/quoteStore.ts), so a socket that opens
    and immediately dies legitimately produces ~60 handshakes a minute from
    ONE tab. Several tabs, or several users behind one carrier NAT, multiply
    that. A ceiling a real user reaches is an outage, not a control, so the
    default is pinned well above real behaviour.
  * Sharing a bucket. Exhausting the WS ceiling must not spend the SSE
    fallback's budget — SSE is precisely where a client goes when WS keeps
    failing, so a shared bucket would turn one failure into both.

The handshake assertions go through TestClient's `websocket_connect` rather
than calling the limiter directly, because the defect was that the limiter
was never *reached* on this path; a unit call would have passed all along.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import ratelimit

# Close code asserted against explicitly: the point of the fix is that a
# refused handshake is distinguishable from the unauthenticated 4401 and from
# a generic transport close, so a client (and an operator reading logs) can
# tell "you are being throttled" from "your token is bad".
_THROTTLED = 4429
_UNAUTHENTICATED = 4401


@pytest.fixture(scope="module")
def client():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    # decode_token and issue_token both read the secret at call time.
    mp.setenv("BACKEND_JWT_SECRET",
              "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    from backend.routes import stream
    # Only the stream router: the app's middleware stack is irrelevant here
    # (that is the whole point — it does not run for a WS upgrade), and
    # leaving it out also keeps the login limiter out of these tests.
    app = FastAPI()
    app.include_router(stream.router, prefix="/api/v1")
    yield TestClient(app)
    mp.undo()


@pytest.fixture()
def token(client):
    from backend import auth
    return auth.issue_token(
        {"username": "ws-test", "role": "user", "plan": ""})["access_token"]


@pytest.fixture(autouse=True)
def _restore():
    hops, ceiling = ratelimit.TRUSTED_PROXY_HOPS, ratelimit.WS_HANDSHAKE_RATE_PER_MIN
    ratelimit._hits.clear()
    yield
    ratelimit.TRUSTED_PROXY_HOPS = hops
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = ceiling
    ratelimit._hits.clear()


def _connect(client, token: str, headers: dict | None = None) -> int | None:
    """One handshake attempt. None if accepted, else the close code.

    That this returns at all is half the assertion: a refused handshake must
    close, not leave the client hanging on a socket that will never speak.
    """
    try:
        with client.websocket_connect(f"/api/v1/stream?token={token}",
                                      headers=headers or {}):
            return None
    except WebSocketDisconnect as exc:
        return exc.code


# ── the ceiling exists at all ─────────────────────────────────────────────

def test_a_normal_connect_still_works(client, token):
    """Guard on the working surface: the throttle must not cost the first
    connection anything."""
    assert _connect(client, token) is None


def test_a_handshake_flood_is_refused(client, token):
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 5
    codes = [_connect(client, token) for _ in range(9)]
    assert codes[:5] == [None] * 5, "attempts under the ceiling must connect"
    # Before the fix every one of the nine was accepted: nothing on this path
    # counted handshakes.
    assert codes[5:] == [_THROTTLED] * 4


def test_the_refusal_code_is_not_the_unauthenticated_one(client, token):
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 1
    assert _connect(client, token) is None
    code = _connect(client, token)
    assert code == _THROTTLED
    assert code != _UNAUTHENTICATED, \
        "a throttled client must not be told its token is bad"


def test_an_unauthenticated_flood_is_counted_too(client):
    """The throttle runs before the token is decoded.

    Flooding does not require a valid token, so a limiter placed after the
    auth check would leave the cheap-to-generate attack uncounted and would
    pay a JWT verification per attempt.
    """
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 3
    codes = [_connect(client, "bogus") for _ in range(6)]
    assert codes[:3] == [_UNAUTHENTICATED] * 3
    assert codes[3:] == [_THROTTLED] * 3


# ── whose handshake is it ─────────────────────────────────────────────────

def test_one_client_cannot_lock_another_out(client, token):
    """The bug's HTTP twin, restated for sockets: per-client buckets.

    Keying on the TCP peer would make this one global bucket behind the
    production Caddy hop, so one script could hold the socket shut for every
    real user. See ratelimit.client_ip.
    """
    ratelimit.TRUSTED_PROXY_HOPS = 1
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 3
    attacker = {"X-Forwarded-For": "198.51.100.1"}
    victim = {"X-Forwarded-For": "203.0.113.9"}

    codes = [_connect(client, token, attacker) for _ in range(6)]
    assert _THROTTLED in codes, "the attacker should hit their own ceiling"
    # The victim has not attempted a single handshake.
    assert _connect(client, token, victim) is None


def test_a_ws_client_cannot_nominate_its_own_bucket(client, token):
    """With no trusted proxy in front, X-Forwarded-For is ignored on the WS
    path exactly as it is on the HTTP path — otherwise an attacker rotates the
    header and is never limited. This is why the handshake reuses
    `client_ip` instead of reading headers itself.
    """
    ratelimit.TRUSTED_PROXY_HOPS = 0
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 3
    codes = [_connect(client, token, {"X-Forwarded-For": f"10.0.0.{i}"})
             for i in range(6)]
    assert _THROTTLED in codes


# ── the ceiling is not in a real client's way ─────────────────────────────

def test_the_default_ceiling_clears_a_real_reconnect_storm():
    """A flapping connection must never be throttled.

    The arithmetic this number has to clear: `scheduleReconnect` waits
    `min(30s, 1000ms * 2**failures) * jitter(0.7..1.3)` and `connectWs`
    resets `failures` to 0 on open, so a socket that opens and drops at once
    retries on the ~1 s floor forever — about 60 attempts a minute from one
    tab. 240 is four such tabs; a shared carrier NAT puts several users on one
    address on top of that.

    Checked through the limiter rather than by reading the constant, so a
    bucket keyed or windowed wrongly fails here too.
    """
    for i in range(240):
        assert ratelimit.allow_ws_handshake("203.0.113.9") is True, \
            f"a real reconnect storm was refused at attempt {i + 1}"


def test_ws_buckets_are_per_client():
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 1
    assert ratelimit.allow_ws_handshake("198.51.100.1") is True
    assert ratelimit.allow_ws_handshake("198.51.100.1") is False
    assert ratelimit.allow_ws_handshake("203.0.113.9") is True


def test_the_ws_bucket_is_separate_from_the_sse_bucket():
    """Failing over from WS to SSE is the normal response to a broken socket,
    so the two must not share a counter in either direction."""
    ratelimit.WS_HANDSHAKE_RATE_PER_MIN = 2
    ws_exhausted = "198.51.100.1"
    assert ratelimit.allow_ws_handshake(ws_exhausted) is True
    assert ratelimit.allow_ws_handshake(ws_exhausted) is True
    assert ratelimit.allow_ws_handshake(ws_exhausted) is False
    # ...and the SSE fallback for that same client is untouched.
    assert ratelimit.allow(ws_exhausted, "/api/v1/stream/sse", "GET") is True

    # The converse: spending the HTTP /stream rule must not close the socket.
    sse_exhausted = "203.0.113.9"
    _prefix, limit, _window = ratelimit._match("/api/v1/stream/sse", "GET")
    for _ in range(limit):
        assert ratelimit.allow(sse_exhausted, "/api/v1/stream/sse", "GET") is True
    assert ratelimit.allow(sse_exhausted, "/api/v1/stream/sse", "GET") is False
    assert ratelimit.allow_ws_handshake(sse_exhausted) is True
