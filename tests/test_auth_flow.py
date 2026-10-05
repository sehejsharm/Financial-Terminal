"""The login / refresh / sign-out flow over HTTP, and the CSRF boundary.

What these pin, beyond "it works":

  * The access token is SHORT-LIVED and the refresh cookie is HttpOnly. The
    old model was a 12-hour JWT in a script-readable cookie, so any XSS read a
    full session credential. Both halves of that fix are asserted here because
    either one alone is worth little.
  * CSRF is required on exactly the two cookie-authenticated endpoints and
    NOT on the ~95 bearer-authenticated ones. The scope is the design, so a
    test that only checked "CSRF is enforced somewhere" would not catch
    someone later applying it everywhere and breaking every data endpoint.
  * Deactivating an account takes effect at the next refresh, which is the
    whole point of making the long-lived credential revocable.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PASSWORD = "test-pw-123"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", PASSWORD)
    monkeypatch.setenv("BACKEND_JWT_SECRET",
                       "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    import lib.auth as lib_auth
    monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
    monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
    monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH",
                        Path(tmp_path) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import sessions
    sessions.configure(Path(tmp_path))
    from backend import app as app_mod
    importlib.reload(app_mod)
    from backend import sessions as s2
    s2.configure(Path(tmp_path))   # reload reset it to the real data dir
    return TestClient(app_mod.app)


def login(client, username="admin", password=PASSWORD):
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


class TestLogin:
    def test_returns_an_access_token_and_sets_a_refresh_cookie(self, client):
        r = login(client)
        body = r.json()
        assert body["access_token"]
        assert "mb_refresh" in r.cookies or "mb_refresh" in client.cookies

    def test_the_refresh_cookie_is_httponly_secure_strict_and_scoped(self, client):
        # The four attributes, each for its own reason:
        #   HttpOnly — script cannot read the session credential (the fix)
        #   SameSite=Strict — never submitted cross-site
        #   Path — not attached to the hundreds of market-data requests
        # Secure is asserted separately because it is off in development.
        raw = login(client).headers["set-cookie"]
        assert "mb_refresh=" in raw
        lowered = raw.lower()
        assert "httponly" in lowered
        assert "samesite=strict" in lowered
        assert "path=/api/v1/auth" in lowered

    def test_the_access_token_is_not_put_in_a_cookie(self, client):
        # The whole point. If the access token is ever also set as a cookie,
        # the XSS exposure comes straight back.
        raw = login(client).headers["set-cookie"]
        assert login(client).json()["access_token"] not in raw

    def test_the_access_token_is_short_lived(self, client):
        from backend.config import JWT_TTL_MINUTES
        # It used to be 720 minutes, which is what made revocation
        # meaningless. The exact number is a judgment call; being under an
        # hour is not.
        assert JWT_TTL_MINUTES <= 60

    def test_the_csrf_cookie_is_readable_on_purpose(self, client):
        # Double-submit needs the client to read it and echo it back, so this
        # one must NOT be HttpOnly. It is worthless on its own.
        raw = login(client).headers["set-cookie"]
        csrf_part = [c for c in raw.split(",") if "mb_csrf=" in c]
        assert csrf_part, raw
        assert "httponly" not in csrf_part[0].lower()

    def test_bad_credentials_set_no_cookie(self, client):
        r = client.post("/api/v1/auth/login",
                        json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401
        assert "mb_refresh" not in r.headers.get("set-cookie", "")

    def test_the_login_appears_in_the_session_list(self, client):
        tok = login(client).json()["access_token"]
        rows = client.get("/api/v1/auth/sessions",
                          headers={"Authorization": f"Bearer {tok}"}).json()
        assert len(rows["sessions"]) == 1


class TestRefresh:
    def test_exchanges_the_cookie_for_a_new_access_token(self, client):
        first = login(client).json()
        csrf = first["csrf_token"]
        r = client.post("/api/v1/auth/refresh",
                        headers={"X-CSRF-Token": csrf})
        assert r.status_code == 200, r.text
        assert r.json()["access_token"]

    def test_the_new_access_token_works(self, client):
        csrf = login(client).json()["csrf_token"]
        tok = client.post("/api/v1/auth/refresh",
                          headers={"X-CSRF-Token": csrf}).json()["access_token"]
        assert client.get("/api/v1/auth/me",
                          headers={"Authorization": f"Bearer {tok}"}).status_code == 200

    def test_the_cookie_rotates(self, client):
        before = client.cookies.get("mb_refresh")
        csrf = login(client).json()["csrf_token"]
        client.post("/api/v1/auth/refresh", headers={"X-CSRF-Token": csrf})
        assert client.cookies.get("mb_refresh") != before

    def test_refresh_without_a_cookie_is_401(self, client):
        login(client)
        csrf = client.cookies.get("mb_csrf")
        client.cookies.delete("mb_refresh", path="/api/v1/auth")
        r = client.post("/api/v1/auth/refresh", headers={"X-CSRF-Token": csrf})
        assert r.status_code == 401

    def test_a_deactivated_account_cannot_refresh(self, client):
        # The reason the long-lived credential had to become revocable:
        # previously this user kept working for up to twelve hours.
        import lib.auth as lib_auth
        lib_auth.create_user("mortal", PASSWORD)
        r = login(client, "mortal", PASSWORD)
        csrf = r.json()["csrf_token"]
        lib_auth.set_active("mortal", False)
        assert client.post("/api/v1/auth/refresh",
                           headers={"X-CSRF-Token": csrf}).status_code == 401

    def test_a_reused_refresh_token_kills_the_session(self, client, monkeypatch):
        from backend import sessions
        csrf = login(client).json()["csrf_token"]
        stolen = client.cookies.get("mb_refresh")
        # The thief refreshes first and succeeds.
        assert client.post("/api/v1/auth/refresh",
                           headers={"X-CSRF-Token": csrf}).status_code == 200
        monkeypatch.setattr(sessions, "ROTATION_GRACE_SECONDS", -1)
        # Now the real client presents what is already superseded. The CSRF
        # token must be the CURRENT one — it is reissued on every refresh, so
        # reusing the login-time value would fail the CSRF check first and
        # test nothing about reuse detection.
        client.cookies.set("mb_refresh", stolen, path="/api/v1/auth")
        r = client.post("/api/v1/auth/refresh",
                        headers={"X-CSRF-Token": client.cookies.get("mb_csrf")})
        assert r.status_code == 401
        assert "reused" in r.json()["detail"].lower()


class TestCsrfBoundary:
    """CSRF is required on the cookie endpoints and nowhere else."""

    def test_refresh_without_the_csrf_header_is_refused(self, client):
        login(client)
        r = client.post("/api/v1/auth/refresh")
        assert r.status_code == 403

    def test_refresh_with_a_mismatched_csrf_header_is_refused(self, client):
        login(client)
        r = client.post("/api/v1/auth/refresh",
                        headers={"X-CSRF-Token": "not-the-cookie"})
        assert r.status_code == 403

    def test_logout_without_the_csrf_header_is_refused(self, client):
        login(client)
        assert client.post("/api/v1/auth/logout").status_code == 403

    def test_csrf_failure_is_403_not_401(self, client):
        # 401 would send a client into a re-authentication loop that cannot
        # fix the problem — the credentials are fine, the origin is not.
        login(client)
        assert client.post("/api/v1/auth/refresh").status_code == 403

    def test_bearer_endpoints_need_no_csrf_token(self, client):
        # The scope of the design. These authenticate with a header no browser
        # attaches cross-site, so they are CSRF-immune by construction, and
        # requiring a token on them would add a failure mode for nothing.
        tok = login(client).json()["access_token"]
        auth = {"Authorization": f"Bearer {tok}"}
        assert client.get("/api/v1/watchlists", headers=auth).status_code == 200
        r = client.put("/api/v1/notes/TCS.NS", headers=auth,
                       json={"body": "a note"})
        assert r.status_code in (200, 204), r.text


class TestLogout:
    def test_ends_the_session_server_side(self, client):
        r = login(client)
        csrf = r.json()["csrf_token"]
        tok = r.json()["access_token"]
        stolen = client.cookies.get("mb_refresh")
        assert client.post("/api/v1/auth/logout",
                           headers={"X-CSRF-Token": csrf}).status_code == 204
        # The refresh token must be dead SERVER-SIDE, not merely forgotten by
        # the browser. So put the cookies back — standing in for someone who
        # kept a copy — and check it still buys nothing. Asserting only that
        # the browser's cookie is gone would pass even if the session were
        # still live on the server.
        client.cookies.set("mb_refresh", stolen, path="/api/v1/auth")
        client.cookies.set("mb_csrf", csrf, path="/api/v1/auth")
        assert client.post("/api/v1/auth/refresh",
                           headers={"X-CSRF-Token": csrf}).status_code == 401
        del tok  # the access token's own expiry is covered elsewhere

    def test_clears_the_cookies(self, client):
        csrf = login(client).json()["csrf_token"]
        raw = client.post("/api/v1/auth/logout",
                          headers={"X-CSRF-Token": csrf}).headers.get("set-cookie", "")
        assert "mb_refresh=" in raw
        # Deleted by setting an empty value with a matching path; a mismatched
        # path would silently leave the user signed in.
        assert "path=/api/v1/auth" in raw.lower()

    def test_logout_is_idempotent(self, client):
        csrf = login(client).json()["csrf_token"]
        client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
        # Already signed out. Reporting an error for something the user wanted
        # anyway is just a confusing message.
        assert client.post("/api/v1/auth/logout",
                           headers={"X-CSRF-Token": csrf}).status_code == 204


class TestSignOutEverywhere:
    def test_ends_every_session_for_the_user(self, client):
        from backend import sessions
        tok = login(client).json()["access_token"]
        # Two more devices.
        sessions.create("admin", user_agent="Phone")
        sessions.create("admin", user_agent="Tablet")
        r = client.post("/api/v1/auth/logout-all",
                        headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        assert r.json()["sessions_ended"] == 3
        assert sessions.list_for("admin") == []

    def test_requires_authentication(self, client):
        assert client.post("/api/v1/auth/logout-all").status_code == 401

    def test_a_named_session_can_be_ended_individually(self, client):
        from backend import sessions
        tok = login(client).json()["access_token"]
        auth = {"Authorization": f"Bearer {tok}"}
        sessions.create("admin", user_agent="Phone")
        rows = client.get("/api/v1/auth/sessions", headers=auth).json()["sessions"]
        other = next(r for r in rows if not r["current"])
        assert client.delete(f"/api/v1/auth/sessions/{other['id']}",
                             headers=auth).status_code == 204
        left = client.get("/api/v1/auth/sessions", headers=auth).json()["sessions"]
        assert len(left) == 1
        assert left[0]["current"] is True

    def test_ending_a_session_that_is_not_yours_is_404(self, client):
        from backend import sessions
        tok = login(client).json()["access_token"]
        sessions.create("someone-else")
        foreign = sessions.list_for("someone-else")[0]["id"]
        r = client.delete(f"/api/v1/auth/sessions/{foreign}",
                          headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 404
        assert len(sessions.list_for("someone-else")) == 1
