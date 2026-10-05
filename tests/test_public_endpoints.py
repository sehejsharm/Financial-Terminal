"""Which endpoints answer an anonymous caller.

The audit found three that should not have: /diag (which disclosed whether each
provider key is configured, plus up to 200 characters of raw upstream error
text, and made four live metered provider calls per hit),
/api/v1/stream/health (operational telemetry whose own docstring says it is for
the admin panel), and the OpenAPI schema with /docs and /redoc (a complete
target map including the admin surface).

This file is written as a ledger rather than a set of one-off assertions: the
public list is enumerated explicitly, so an endpoint added without a dependency
in future shows up here as a failure instead of as a quiet new public surface.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Public ON PURPOSE, with the reason. Each of these was reviewed:
#   /healthz  — the compose healthcheck and the host watchdog probe hit it with
#               no credentials; returns {ok, ts} only.
#   /version  — APP_VERSION plus cache entry counts. Mild infrastructure
#               disclosure, no secret, and useful without a login.
INTENTIONALLY_PUBLIC = ["/healthz", "/version"]

# Must NOT answer an anonymous caller.
MUST_BE_GATED = [
    "/diag",
    "/api/v1/stream/health",
]


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    tmp = tmp_path_factory.mktemp("pub")
    mp.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    mp.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    mp.setenv("BACKEND_JWT_SECRET",
              "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    mp.delenv("EXPOSE_API_DOCS", raising=False)
    import lib.auth as lib_auth
    mp.setattr(lib_auth, "DATA_DIR", Path(tmp))
    mp.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    mp.setattr(lib_auth, "INITIAL_PW_PATH", Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))
    from backend import app as app_mod
    importlib.reload(app_mod)
    yield TestClient(app_mod.app)
    mp.undo()


class TestGatedEndpoints:
    @pytest.mark.parametrize("path", MUST_BE_GATED)
    def test_an_anonymous_caller_is_refused(self, client, path):
        r = client.get(path)
        assert r.status_code in (401, 403), \
            f"{path} answered an anonymous caller with {r.status_code}"

    def test_diag_does_not_leak_provider_config_to_anonymous_callers(self, client):
        # The specific disclosure: which paid provider keys are configured.
        body = client.get("/diag").text
        assert "twelve_data" not in body
        assert "configured" not in body

    def test_diag_still_works_for_a_master_admin(self, client):
        # Gating it must not take ops triage away — it still has to answer the
        # operator, who already holds this token.
        tok = client.post("/api/v1/auth/login",
                          json={"username": "admin",
                                "password": "test-pw-123"}).json()["access_token"]
        r = client.get("/diag", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        assert "providers" in r.json()


class TestIntentionallyPublic:
    @pytest.mark.parametrize("path", INTENTIONALLY_PUBLIC)
    def test_still_answers_without_credentials(self, client, path):
        # The watchdog and the container healthcheck have no token. Gating
        # /healthz would make the restart loop the outage.
        assert client.get(path).status_code == 200

    def test_healthz_discloses_nothing_but_liveness(self, client):
        assert set(client.get("/healthz").json()) == {"ok", "ts"}


class TestApiDocsAreOffByDefault:
    @pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
    def test_not_served_without_the_flag(self, client, path):
        assert client.get(path).status_code == 404

    def test_served_when_the_flag_is_set(self, client, monkeypatch, tmp_path):
        # The flag has to actually work, or the next person debugging locally
        # concludes the docs are gone and reverts the default.
        monkeypatch.setenv("EXPOSE_API_DOCS", "1")
        from backend import app as app_mod
        importlib.reload(app_mod)
        try:
            assert TestClient(app_mod.app).get("/openapi.json").status_code == 200
        finally:
            monkeypatch.delenv("EXPOSE_API_DOCS", raising=False)
            importlib.reload(app_mod)


def _walk(routes, prefix="", inherited=0):
    """Every concrete route, with its full path and how many dependencies
    guard it.

    This has to recurse. `app.routes` on this FastAPI version does not hold
    flattened APIRoutes — `include_router` leaves a wrapper object carrying
    the original router and the prefix it was mounted at, so iterating
    `app.routes` and reading `.path` yields nothing at all. A guard test built
    on that would pass forever while checking no routes, which is worse than
    not having it.
    """
    for route in routes:
        ctx = getattr(route, "include_context", None)
        if ctx is not None:
            # A router included with dependencies=[...] guards everything
            # underneath it, so carry that count down.
            yield from _walk(ctx.included_router.routes,
                             prefix + (ctx.prefix or ""),
                             inherited + len(ctx.dependencies or []))
            continue
        path = getattr(route, "path", None)
        if path is None:
            continue
        deps = getattr(getattr(route, "dependant", None), "dependencies", [])
        yield prefix + path, inherited + len(deps)


class TestTheAuthFreeRoutesAreEnumerated:
    def test_the_walker_actually_finds_the_routes(self, client):
        """Guard for the guard.

        The check below is only worth anything if it sees the real route
        table. Pin that it finds a known-authenticated route and a known
        public one, so the next refactor of FastAPI's internals fails here
        loudly instead of silently emptying the audit.
        """
        from backend import app as app_mod
        found = dict(_walk(app_mod.app.routes))
        assert len(found) > 40, f"only found {len(found)} routes"
        assert "/healthz" in found
        assert found.get("/api/v1/watchlists", 0) > 0, \
            "a known-authenticated route came back unguarded"

    def test_no_unreviewed_route_lacks_a_dependency(self, client):
        """Every route either has a dependency or is on the reviewed list.

        This is the test that keeps the audit from needing to be redone. A new
        route added without auth fails here and the author has to either add a
        dependency or put it on INTENTIONALLY_PUBLIC with a reason.
        """
        from backend import app as app_mod

        # Routes that are public but authenticate from a query parameter
        # rather than a dependency, because an EventSource and a WebSocket
        # cannot set an Authorization header. Verified by reading them: both
        # call auth.decode_token and reject with 4401/401.
        token_in_query = {"/api/v1/stream", "/api/v1/stream/sse"}
        # The login and passkey ceremony endpoints cannot require a token —
        # they are how you get one. They are rate-limited instead.
        credential_issuing = {
            "/api/v1/auth/login",
            "/api/v1/auth/passkey/support",
            "/api/v1/auth/passkey/login/begin",
            "/api/v1/auth/passkey/login/finish",
        }
        allowed = (set(INTENTIONALLY_PUBLIC) | token_in_query
                   | credential_issuing)

        unguarded = [path for path, ndeps in _walk(app_mod.app.routes)
                     if path not in allowed and not ndeps]

        assert not unguarded, (
            "these routes answer an anonymous caller and are not on the "
            f"reviewed public list: {sorted(set(unguarded))}"
        )
