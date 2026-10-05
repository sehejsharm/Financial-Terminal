"""API security headers, and the CORS allowlist.

The API shipped with no security headers at all. These pin the ones added, and
in particular pin them on the responses that are easiest to forget: the 4xx
from a validation failure, the 401 from a missing token, and the 429 the rate
limiter short-circuits before any route runs. A header set only on the happy
path is a header that is absent exactly when something is going wrong.

The CORS assertions check the property the brief asks for — an unlisted origin
is not granted access — rather than the configuration literal, because what
matters is what the browser is told, not what the dict says.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.security_headers import SECURITY_HEADERS

ALLOWED_ORIGIN = "http://localhost:3000"      # the configured dev default
UNLISTED_ORIGIN = "https://evil.example"


@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    tmp = tmp_path_factory.mktemp("sec")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    monkeymodule.setenv("BACKEND_JWT_SECRET",
                        "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    import lib.auth as lib_auth
    monkeymodule.setattr(lib_auth, "DATA_DIR", Path(tmp))
    monkeymodule.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    monkeymodule.setattr(lib_auth, "INITIAL_PW_PATH",
                         Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))
    from backend import app as app_mod
    importlib.reload(app_mod)
    return TestClient(app_mod.app)


class TestHeadersArePresent:
    def test_on_a_healthy_response(self, client):
        r = client.get("/healthz")
        assert r.status_code == 200
        for key, value in SECURITY_HEADERS.items():
            assert r.headers.get(key) == value, f"missing/wrong: {key}"

    def test_on_a_401(self, client):
        # The response an unauthenticated caller sees must be as hardened as
        # any other.
        r = client.get("/api/v1/watchlists")
        assert r.status_code in (401, 403)
        assert r.headers.get("X-Content-Type-Options") == "nosniff"
        assert r.headers.get("Content-Security-Policy", "").startswith("default-src 'none'")

    def test_on_a_404(self, client):
        r = client.get("/api/v1/definitely-not-a-route")
        assert r.status_code == 404
        assert r.headers.get("X-Frame-Options") == "DENY"

    def test_on_a_rate_limited_429(self, client):
        # The limiter short-circuits before the route runs, which is exactly
        # the path a middleware added in the wrong order would miss.
        from backend import ratelimit
        ratelimit._hits.clear()
        codes = []
        last = None
        for _ in range(14):
            last = client.post("/api/v1/auth/login",
                               json={"username": "nobody", "password": "wrong"})
            codes.append(last.status_code)
        ratelimit._hits.clear()
        assert 429 in codes, "expected the limiter to trip"
        assert last.headers.get("X-Content-Type-Options") == "nosniff"

    def test_the_api_csp_forbids_everything(self, client):
        # An API response should never load a resource. If one is ever
        # rendered as a document, this means it can do nothing when it gets
        # there.
        csp = client.get("/healthz").headers.get("Content-Security-Policy", "")
        assert "default-src 'none'" in csp
        assert "frame-ancestors 'none'" in csp

    def test_referrer_is_not_leaked(self, client):
        # Paths here carry tickers and, for the Sheets path, a token in the
        # query string.
        assert client.get("/healthz").headers.get("Referrer-Policy") == "no-referrer"


class TestCorsAllowlist:
    def test_an_allowed_origin_is_granted(self, client):
        r = client.get("/healthz", headers={"Origin": ALLOWED_ORIGIN})
        assert r.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN

    def test_an_UNLISTED_origin_is_not_granted(self, client):
        # The brief's acceptance criterion. A browser denies the read when the
        # allow-origin header is absent or does not echo the caller.
        r = client.get("/healthz", headers={"Origin": UNLISTED_ORIGIN})
        allowed = r.headers.get("access-control-allow-origin")
        assert allowed != UNLISTED_ORIGIN
        assert allowed != "*"

    def test_the_preflight_for_an_unlisted_origin_is_not_granted(self, client):
        r = client.options("/api/v1/watchlists", headers={
            "Origin": UNLISTED_ORIGIN,
            "Access-Control-Request-Method": "POST",
        })
        assert r.headers.get("access-control-allow-origin") not in (UNLISTED_ORIGIN, "*")

    def test_credentials_are_never_paired_with_a_wildcard(self, client):
        # allow_credentials=True with allow_origins=["*"] is the classic
        # footgun; browsers reject it, but the config should never express it.
        from backend.config import CORS_ORIGINS
        assert "*" not in CORS_ORIGINS
