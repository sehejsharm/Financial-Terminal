"""FastAPI backend smoke tests — no network, uses TestClient + temp data dir.

Covers: login flow, JWT verification, watchlists CRUD, audit middleware,
admin-role gating. The market/AI endpoints aren't unit-tested here because
they call external services (yfinance / Groq); they're exercised by the
existing lib/ tests.
"""
from __future__ import annotations

import importlib
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    """Spin up the API with a fresh data dir and a seeded admin."""
    tmp = tmp_path_factory.mktemp("backend")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    monkeymodule.setenv("BACKEND_JWT_SECRET",
                        "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")

    # Point both lib/auth and backend storage at the temp dir.
    import lib.auth as lib_auth
    monkeymodule.setattr(lib_auth, "DATA_DIR", Path(tmp))
    monkeymodule.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    monkeymodule.setattr(lib_auth, "INITIAL_PW_PATH",
                         Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")

    # Force seed.
    lib_auth._save(lib_auth._seed())

    # Build storage rooted in tmp BEFORE importing app.
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))

    # Import app fresh so our patches above take effect.
    from backend import app as app_mod
    importlib.reload(app_mod)
    return TestClient(app_mod.app)


@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def token(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def auth_h(token):
    return {"Authorization": f"Bearer {token}"}


# ── health (unauthenticated) ────────────────────────────────────────────────
def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_version(client):
    r = client.get("/version")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "motherboard-api"
    assert "cache" in body


# ── auth ────────────────────────────────────────────────────────────────────
def test_login_wrong_password(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401


def test_me_requires_token(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_returns_user(client, auth_h):
    r = client.get("/api/v1/auth/me", headers=auth_h)
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "admin"
    assert body["role"] == "master_admin"


def test_bad_token_rejected(client):
    r = client.get("/api/v1/auth/me",
                   headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401


# ── watchlists ──────────────────────────────────────────────────────────────
def test_watchlists_crud(client, auth_h):
    # empty to start
    r = client.get("/api/v1/watchlists", headers=auth_h)
    assert r.status_code == 200 and r.json() == []

    # create
    r = client.post("/api/v1/watchlists", headers=auth_h,
                    json={"name": "Tech", "tickers": ["aapl", "msft"]})
    assert r.status_code == 201
    wl = r.json()
    assert wl["name"] == "Tech"
    assert wl["tickers"] == ["AAPL", "MSFT"]
    wl_id = wl["id"]

    # update
    r = client.put(f"/api/v1/watchlists/{wl_id}", headers=auth_h,
                   json={"name": "Tech US", "tickers": ["AAPL", "GOOG"]})
    assert r.status_code == 200
    assert r.json()["name"] == "Tech US"
    assert r.json()["tickers"] == ["AAPL", "GOOG"]

    # list shows the update
    r = client.get("/api/v1/watchlists", headers=auth_h)
    assert r.status_code == 200
    assert any(w["id"] == wl_id and w["name"] == "Tech US" for w in r.json())

    # delete
    r = client.delete(f"/api/v1/watchlists/{wl_id}", headers=auth_h)
    assert r.status_code == 204
    r = client.delete(f"/api/v1/watchlists/{wl_id}", headers=auth_h)
    assert r.status_code == 404


# ── admin / audit ───────────────────────────────────────────────────────────
def test_admin_users_list(client, auth_h):
    r = client.get("/api/v1/admin/users", headers=auth_h)
    assert r.status_code == 200
    assert any(u["username"].lower() == "admin" for u in r.json())


def test_admin_create_user_then_login(client, auth_h):
    r = client.post("/api/v1/admin/users", headers=auth_h,
                    json={"username": "analyst1",
                          "password": "analyst-pw-123",
                          "role": "user"})
    assert r.status_code == 201
    # The new user can log in.
    r = client.post("/api/v1/auth/login",
                    json={"username": "analyst1", "password": "analyst-pw-123"})
    assert r.status_code == 200
    new_token = r.json()["access_token"]
    # …but cannot reach an admin route.
    r = client.get("/api/v1/admin/users",
                   headers={"Authorization": f"Bearer {new_token}"})
    assert r.status_code == 403


def test_audit_records_requests(client, auth_h):
    # Make a recognisable request, then read the tail.
    client.get("/api/v1/auth/me", headers=auth_h)
    r = client.get("/api/v1/admin/audit?limit=50", headers=auth_h)
    assert r.status_code == 200
    events = r.json()
    assert isinstance(events, list) and len(events) > 0
    # the most recent /auth/me call is in there
    assert any(e["path"] == "/api/v1/auth/me" and e["user"] == "admin"
               for e in events)
    # latency_ms and status are populated
    sample = events[-1]
    for k in ("ts", "user", "method", "path", "status", "latency_ms"):
        assert k in sample
