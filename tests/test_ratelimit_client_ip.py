"""Whose request is this? — the rate limiter's bucket key.

The limiter was keying on `request.client.host`. Behind the production Caddy
hop that is the proxy's bridge address for every request, so all six rules
collapsed into one bucket shared by the entire internet: ten login attempts a
minute globally, which is both trivially exhausted by one script (locking every
real user out of login) and no per-attacker throttle at all.

These tests pin the two halves of the fix that can be got wrong in opposite
directions:

  * trusting the header when we should not (a caller then picks its own bucket
    key and has no limit), and
  * not trusting it when we should (the global-bucket bug comes back).

They assert behaviour through `client_ip` and through the middleware, not the
shape of the config, because the failure mode here was invisible in the config
and only showed up in who got charged.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import ratelimit
from backend.ratelimit import RateLimitMiddleware


class _Req:
    """The two things client_ip reads, and nothing else."""

    def __init__(self, peer: str | None, xff: str | None = None):
        self.client = type("C", (), {"host": peer})() if peer else None
        self.headers = {"x-forwarded-for": xff} if xff else {}


@pytest.fixture(autouse=True)
def _clean():
    ratelimit._hits.clear()
    before = ratelimit.TRUSTED_PROXY_HOPS
    yield
    ratelimit.TRUSTED_PROXY_HOPS = before
    ratelimit._hits.clear()


class TestClientIpWithNoProxy:
    """TRUSTED_PROXY_HOPS=0, the default: the socket is the only truth."""

    def test_uses_the_socket_peer(self):
        ratelimit.TRUSTED_PROXY_HOPS = 0
        assert ratelimit.client_ip(_Req("203.0.113.9")) == "203.0.113.9"

    def test_ignores_a_forwarded_for_header_entirely(self):
        # This is the important one. An app reachable directly must never let
        # a caller nominate its own bucket: if it does, the attacker rotates
        # the header and is never limited.
        ratelimit.TRUSTED_PROXY_HOPS = 0
        req = _Req("203.0.113.9", xff="1.1.1.1")
        assert ratelimit.client_ip(req) == "203.0.113.9"

    def test_a_missing_peer_does_not_raise(self):
        ratelimit.TRUSTED_PROXY_HOPS = 0
        assert ratelimit.client_ip(_Req(None)) == "unknown"


class TestClientIpBehindOneProxy:
    """TRUSTED_PROXY_HOPS=1, the production topology."""

    def test_uses_the_address_the_proxy_appended(self):
        ratelimit.TRUSTED_PROXY_HOPS = 1
        # Caddy's bridge IP is the peer; the client is what Caddy wrote.
        req = _Req("172.18.0.3", xff="203.0.113.9")
        assert ratelimit.client_ip(req) == "203.0.113.9"

    def test_a_spoofed_prefix_cannot_change_the_answer(self):
        # The caller sent "X-Forwarded-For: 1.1.1.1"; Caddy APPENDED the peer
        # it actually saw. The rightmost entry is therefore the only one the
        # caller could not write, which is why it is the one we use.
        ratelimit.TRUSTED_PROXY_HOPS = 1
        req = _Req("172.18.0.3", xff="1.1.1.1, 203.0.113.9")
        assert ratelimit.client_ip(req) == "203.0.113.9"

    def test_a_long_spoofed_chain_cannot_change_the_answer(self):
        ratelimit.TRUSTED_PROXY_HOPS = 1
        req = _Req("172.18.0.3",
                   xff="1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9")
        assert ratelimit.client_ip(req) == "203.0.113.9"

    def test_falls_back_to_the_peer_when_the_header_is_absent(self):
        # A request that did not come through the proxy we think it did.
        # Believing a header that isn't there would mean no key at all.
        ratelimit.TRUSTED_PROXY_HOPS = 1
        assert ratelimit.client_ip(_Req("172.18.0.3")) == "172.18.0.3"

    def test_a_non_address_is_rejected(self):
        # Not something a correct proxy writes. Accepting it would also let a
        # junk chain mint unbounded distinct bucket keys.
        ratelimit.TRUSTED_PROXY_HOPS = 1
        req = _Req("172.18.0.3", xff="not-an-ip")
        assert ratelimit.client_ip(req) == "172.18.0.3"

    def test_two_hops_reads_two_from_the_right(self):
        ratelimit.TRUSTED_PROXY_HOPS = 2
        # client, then outer proxy appended by the inner one.
        req = _Req("10.0.0.1", xff="203.0.113.9, 10.0.0.2")
        assert ratelimit.client_ip(req) == "203.0.113.9"


class TestBucketsAreNotShared:
    """The bug, stated as a property: one caller cannot exhaust another's."""

    def _app(self):
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware)

        @app.post("/api/v1/auth/login")
        def login():
            return {"ok": True}

        return TestClient(app)

    def test_one_client_cannot_lock_another_out_of_login(self):
        ratelimit.TRUSTED_PROXY_HOPS = 1
        client = self._app()
        attacker = {"X-Forwarded-For": "198.51.100.1"}
        victim = {"X-Forwarded-For": "203.0.113.9"}

        # Burn the attacker's entire login budget.
        codes = [client.post("/api/v1/auth/login", headers=attacker).status_code
                 for _ in range(20)]
        assert 429 in codes, "the attacker should hit their own ceiling"

        # The victim has not made a single request and must be unaffected.
        # Before the fix this was a 429: same bucket.
        assert client.post("/api/v1/auth/login", headers=victim).status_code == 200

    def test_a_single_client_is_still_limited(self):
        # The flip side: making the key per-client must not make it per-request.
        ratelimit.TRUSTED_PROXY_HOPS = 1
        client = self._app()
        hdr = {"X-Forwarded-For": "198.51.100.1"}
        codes = [client.post("/api/v1/auth/login", headers=hdr).status_code
                 for _ in range(20)]
        assert codes.count(429) > 0
        assert codes.count(200) <= 10  # the /auth/login rule


class TestRuleCoverage:
    """The prefixes that had no ceiling at all."""

    @pytest.mark.parametrize("path,method", [
        ("/api/v1/market/quote-bulk", "POST"),   # rule was GET-only
        ("/api/v1/data/bdp", "GET"),
        ("/api/v1/screens/custom", "POST"),
        ("/api/v1/fundamentals/RELIANCE.NS", "GET"),
        ("/api/v1/options/chain", "GET"),
        ("/api/v1/value-chain/RELIANCE.NS", "GET"),
        ("/api/v1/macro/series", "GET"),
        ("/api/v1/deals/", "GET"),
        ("/api/v1/portfolio/import", "POST"),
        ("/api/v1/watchlists", "GET"),
        ("/api/v1/notes/TCS.NS", "PUT"),
        ("/api/v1/workspaces", "GET"),
        ("/api/v1/stream/sse", "GET"),
        ("/api/v1/ai/provider", "GET"),          # rule was POST-only
        ("/api/v1/something-added-next-year", "GET"),  # the backstop
    ])
    def test_every_v1_prefix_has_a_ceiling(self, path, method):
        assert ratelimit._match(path, method) is not None, \
            f"{method} {path} has no rate-limit rule"

    def test_the_backstop_is_last_so_it_never_shadows_a_specific_rule(self):
        # First match wins, so a misplaced "/api/v1" entry would silently give
        # /auth/login a 600/min ceiling.
        prefixes = [p for p, _, _, _ in ratelimit._RULES]
        assert prefixes[-1] == "/api/v1"
        assert prefixes.count("/api/v1") == 1

    def test_login_still_gets_the_strict_rule_not_the_backstop(self):
        prefix, limit, _ = ratelimit._match("/api/v1/auth/login", "POST")
        assert prefix == "/api/v1/auth/login"
        assert limit == 10

    def test_passkeys_keep_their_own_bucket(self):
        # Exhausting the passkey ceremony budget must never spend the password
        # login budget — that would lock a user out of the fallback that exists
        # for when the passkey does not work.
        assert ratelimit._match("/api/v1/auth/passkey/login/begin", "POST")[0] \
            == "/api/v1/auth/passkey"


class TestEviction:
    def test_a_full_table_does_not_forgive_live_buckets(self):
        # The old backstop was _hits.clear(), which reset every counter the
        # moment the table filled — failing open exactly when the table is
        # full because someone is hammering it.
        ratelimit.TRUSTED_PROXY_HOPS = 0
        import time as _t
        now = _t.time()
        # One live bucket at its ceiling, plus a flood of long-dead ones.
        ratelimit._hits["live:/api/v1/auth/login:POST"] = [now] * 10
        for i in range(ratelimit._MAX_KEYS + 10):
            ratelimit._hits[f"dead{i}"] = [now - 3600]

        assert ratelimit.allow("live", "/api/v1/auth/login", "POST") is False
        # The dead keys are gone, the live one still holds its count.
        assert len(ratelimit._hits) < ratelimit._MAX_KEYS
        assert "live:/api/v1/auth/login:POST" in ratelimit._hits
