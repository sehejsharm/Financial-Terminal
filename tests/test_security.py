"""Phase 3 security hardening: rate limiting, admin audit events, and the
password-handling invariants (hashed at rest, never returned by the API)."""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    tmp = tmp_path_factory.mktemp("security")
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


@pytest.fixture(scope="module")
def admin_headers(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_login_rate_limited_per_ip(client):
    """More than 10 login attempts/min from one IP → 429 (brute-force guard
    beyond the per-username lockout)."""
    from backend import ratelimit
    ratelimit._hits.clear()
    codes = []
    for _ in range(12):
        r = client.post("/api/v1/auth/login",
                        json={"username": "nobody", "password": "wrong"})
        codes.append(r.status_code)
    assert 429 in codes
    assert codes[0] != 429                       # first attempts pass through
    ratelimit._hits.clear()                      # don't poison later tests


def test_admin_actions_write_explicit_audit_events(client, admin_headers):
    r = client.post("/api/v1/admin/users",
                    json={"username": "carol", "password": "carol-pw-1234",
                          "role": "user"},
                    headers=admin_headers)
    assert r.status_code == 201
    r = client.delete("/api/v1/admin/users/carol", headers=admin_headers)
    assert r.status_code == 204

    audit = client.get("/api/v1/admin/audit?limit=200", headers=admin_headers).json()
    paths = [e.get("path") for e in audit]
    assert "admin:user_created:carol" in paths
    assert "admin:user_deactivated:carol" in paths
    created = next(e for e in audit if e["path"] == "admin:user_created:carol")
    assert created["user"] == "admin"            # actor recorded
    assert created["ts"]                         # immutable UTC timestamp


def test_role_assignment_server_validated(client, admin_headers):
    """A made-up role from the client demotes to plain 'user' — role is never
    trusted from input."""
    r = client.post("/api/v1/admin/users",
                    json={"username": "dave", "password": "dave-pw-12345",
                          "role": "superuser_hax"},
                    headers=admin_headers)
    assert r.status_code == 201
    users = client.get("/api/v1/admin/users", headers=admin_headers).json()
    dave = next(u for u in users if u["username"] == "dave")
    assert dave["role"] == "user"


def test_passwords_hashed_and_never_returned(client, admin_headers):
    import json
    import lib.auth as lib_auth
    raw = json.dumps(json.loads(lib_auth.USERS_PATH.read_text()))
    assert "test-pw-123" not in raw              # never plaintext at rest
    assert "dave-pw-12345" not in raw
    users = client.get("/api/v1/admin/users", headers=admin_headers).json()
    blob = json.dumps(users)
    assert "hash" not in blob and "salt" not in blob and "pw" not in blob.lower()


def test_alert_creation_requires_auth(client):
    r = client.post("/api/v1/alerts",
                    json={"kind": "price", "ticker": "AAPL", "op": ">", "value": 1})
    assert r.status_code in (401, 403)
