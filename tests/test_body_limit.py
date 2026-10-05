"""Request body size caps.

There was no cap anywhere: not in uvicorn's flags, not in the Caddyfile, not
in the app. The container is capped at 768 MB, so a single large body was a
restart; the endpoints that persist to the mounted volume made it an unbounded
disk write on the same disk the user database lives on.

The case worth testing is not the big obvious one. It is the request that
declares NO Content-Length — a chunked upload — because a limit that only
reads the header is bypassed by omitting the header, and that bypass looks
exactly like a working limit in every test that sends a normal request.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.responses import JSONResponse

from backend.body_limit import BODY_LIMITS, BodyLimitMiddleware, limit_for


@pytest.fixture(scope="module")
def client():
    """Routes that echo the byte count they actually received.

    Declared as raw Starlette routes rather than FastAPI handlers with a
    pydantic model: the point is what reaches the handler, so the body must
    not be parsed or validated on the way in.
    """
    async def echo(request: Request):
        return JSONResponse({"got": len(await request.body())})

    async def ok(request: Request):
        return JSONResponse({"ok": True})

    app = FastAPI()
    app.add_middleware(BodyLimitMiddleware)
    app.add_route("/api/v1/auth/login", echo, methods=["POST"])
    app.add_route("/api/v1/portfolio/import", echo, methods=["POST"])
    app.add_route("/api/v1/market/quote", ok, methods=["GET"])
    return TestClient(app)


class TestLimitSelection:
    def test_an_unlisted_path_gets_the_default(self):
        from backend.body_limit import DEFAULT_MAX_BODY
        assert limit_for("/api/v1/anything") == DEFAULT_MAX_BODY

    def test_the_csv_import_gets_the_large_cap(self):
        assert limit_for("/api/v1/portfolio/import") == 5 * 1024 * 1024

    def test_auth_gets_the_smallest_cap(self):
        # A login body is a fixed, tiny shape. Anything large is never real.
        assert limit_for("/api/v1/auth/login") == 16 * 1024

    def test_the_caps_are_ordered_specific_before_general(self):
        # First match wins. /api/v1/portfolio/import must precede any
        # /api/v1/portfolio entry, or the import silently inherits the small
        # cap and breaks a working feature.
        prefixes = [p for p, _ in BODY_LIMITS]
        for i, p in enumerate(prefixes):
            for later in prefixes[i + 1:]:
                assert not later.startswith(p) or later == p, \
                    f"{later} is shadowed by the earlier {p}"


class TestEnforcement:
    def test_a_normal_body_passes(self):
        r = client_post_json(b"x" * 1000)
        assert r.status_code == 200
        assert r.json()["got"] == 1000

    def test_an_oversized_declared_body_is_rejected(self):
        r = client_post_json(b"x" * (17 * 1024))
        assert r.status_code == 413
        assert "too large" in r.json()["detail"].lower()

    def test_the_rejection_states_the_limit(self):
        # A client that gets a bare error cannot tell whether to retry
        # smaller or give up.
        r = client_post_json(b"x" * (17 * 1024))
        assert "16384" in r.json()["detail"]

    def test_an_oversized_chunked_body_is_rejected(self):
        # The bypass case: no Content-Length at all. A header-only check lets
        # this straight through.
        r = _CLIENT.post("/api/v1/auth/login",
                         content=_chunks(b"x" * 1024, 20))
        assert r.status_code == 413

    def test_a_within_limit_chunked_body_passes(self):
        r = _CLIENT.post("/api/v1/auth/login", content=_chunks(b"x" * 1024, 4))
        assert r.status_code == 200
        assert r.json()["got"] == 4096

    def test_the_large_cap_endpoint_accepts_a_real_csv(self):
        # Never break a working surface to fix a non-working one: a broker
        # export of a few hundred KB has to keep importing.
        r = _CLIENT.post("/api/v1/portfolio/import", content=b"x" * (300 * 1024))
        assert r.status_code == 200

    def test_a_get_is_not_measured(self):
        assert _CLIENT.get("/api/v1/market/quote").status_code == 200


# ── helpers ───────────────────────────────────────────────────────────────
_CLIENT = None


@pytest.fixture(autouse=True)
def _bind(client):
    global _CLIENT
    _CLIENT = client
    yield


def client_post_json(body: bytes):
    return _CLIENT.post("/api/v1/auth/login", content=body)


def _chunks(chunk: bytes, n: int):
    """A generator body, which httpx sends with Transfer-Encoding: chunked
    and no Content-Length."""
    def gen():
        for _ in range(n):
            yield chunk
    return gen()
