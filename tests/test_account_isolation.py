"""One account must never see another's notes, portfolio, watchlists or alerts.

Prompted by what looked like leftover test data appearing in Notes. The audit
found the routes structurally sound — every handler derives the username from
the verified session and none accepts one from the request — but "looks right"
is not the same as "is tested", and a leak here is the kind of bug that ends a
product rather than annoying a user.

These are deliberately black-box: they drive the real HTTP surface with two
real sessions, so they would catch a regression anywhere in the chain — a
route that starts trusting a query parameter, a storage layer that stops
keying by user, a cache that forgets to include the account in its key.
"""
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
    tmp = tmp_path_factory.mktemp("isolation")
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


def _headers(client, username, password):
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(client):
    return _headers(client, "admin", "test-pw-123")


@pytest.fixture(scope="module")
def two_users(client, admin):
    """Two ordinary accounts, created through the real admin endpoint."""
    for name in ("alice", "bob"):
        r = client.post("/api/v1/admin/users", headers=admin,
                        json={"username": name, "password": f"{name}-pw-12345",
                              "role": "user"})
        assert r.status_code in (201, 400), r.text
    return (_headers(client, "alice", "alice-pw-12345"),
            _headers(client, "bob", "bob-pw-12345"))


class TestNotes:
    def test_a_note_is_invisible_to_another_account(self, client, two_users):
        alice, bob = two_users
        client.put("/api/v1/notes/RELIANCE.NS", headers=alice,
                   json={"text": "alice's private thesis", "tags": ["secret"]})
        r = client.get("/api/v1/notes/RELIANCE.NS", headers=bob)
        assert r.status_code == 200
        assert "alice" not in (r.json().get("text") or "")

    def test_each_account_reads_back_its_OWN_note(self, client, two_users):
        alice, bob = two_users
        client.put("/api/v1/notes/TCS.NS", headers=alice, json={"text": "A"})
        client.put("/api/v1/notes/TCS.NS", headers=bob, json={"text": "B"})
        assert client.get("/api/v1/notes/TCS.NS", headers=alice).json()["text"] == "A"
        assert client.get("/api/v1/notes/TCS.NS", headers=bob).json()["text"] == "B"

    def test_one_account_cannot_overwrite_another_s_note(self, client, two_users):
        alice, bob = two_users
        client.put("/api/v1/notes/INFY.NS", headers=alice, json={"text": "keep"})
        client.put("/api/v1/notes/INFY.NS", headers=bob, json={"text": "clobber"})
        assert client.get("/api/v1/notes/INFY.NS", headers=alice).json()["text"] == "keep"


class TestWatchlists:
    def test_a_watchlist_is_invisible_to_another_account(self, client, two_users):
        alice, bob = two_users
        r = client.post("/api/v1/watchlists", headers=alice,
                        json={"name": "Alice Ideas", "tickers": ["RELIANCE.NS"]})
        assert r.status_code == 201, r.text
        names = [w["name"] for w in client.get("/api/v1/watchlists", headers=bob).json()]
        assert "Alice Ideas" not in names

    def test_another_account_cannot_DELETE_it_by_id(self, client, two_users):
        # The id is a guessable handle, so the route must check ownership
        # rather than just existence.
        alice, bob = two_users
        wl = client.post("/api/v1/watchlists", headers=alice,
                         json={"name": "Targets", "tickers": ["TCS.NS"]}).json()
        assert client.delete(f"/api/v1/watchlists/{wl['id']}",
                             headers=bob).status_code == 404
        names = [w["name"] for w in client.get("/api/v1/watchlists", headers=alice).json()]
        assert "Targets" in names

    def test_another_account_cannot_OVERWRITE_it_by_id(self, client, two_users):
        alice, bob = two_users
        wl = client.post("/api/v1/watchlists", headers=alice,
                         json={"name": "Core", "tickers": ["INFY.NS"]}).json()
        r = client.put(f"/api/v1/watchlists/{wl['id']}", headers=bob,
                       json={"name": "Hijacked", "tickers": ["X"]})
        assert r.status_code == 404
        names = [w["name"] for w in client.get("/api/v1/watchlists", headers=alice).json()]
        assert "Core" in names and "Hijacked" not in names


class TestPortfolio:
    def test_positions_are_invisible_to_another_account(self, client, two_users):
        alice, bob = two_users
        r = client.post("/api/v1/portfolio/positions", headers=alice,
                        json={"ticker": "RELIANCE.NS", "qty": 10, "cost": 1400})
        assert r.status_code == 201, r.text
        bob_rows = client.get("/api/v1/portfolio", headers=bob).json()
        blob = str(bob_rows)
        assert "RELIANCE" not in blob

    def test_another_account_cannot_delete_a_position_by_id(self, client, two_users):
        alice, bob = two_users
        client.post("/api/v1/portfolio/positions", headers=alice,
                    json={"ticker": "TCS.NS", "qty": 5, "cost": 3900})
        mine = client.get("/api/v1/portfolio", headers=alice).json()
        rows = mine if isinstance(mine, list) else mine.get("positions", [])
        pos = next((p for p in rows if p.get("ticker") == "TCS.NS"), None)
        assert pos, mine
        r = client.delete(f"/api/v1/portfolio/positions/{pos['id']}", headers=bob)
        assert r.status_code in (403, 404)
        still = str(client.get("/api/v1/portfolio", headers=alice).json())
        assert "TCS.NS" in still

    def test_a_new_account_starts_EMPTY(self, client, two_users):
        # Leftover data showing up for a fresh account is the symptom that
        # started this audit.
        _alice, bob = two_users
        rows = client.get("/api/v1/portfolio", headers=bob).json()
        rows = rows if isinstance(rows, list) else rows.get("positions", [])
        assert rows == []


class TestAlerts:
    def test_alerts_are_invisible_to_another_account(self, client, two_users):
        alice, bob = two_users
        r = client.post("/api/v1/alerts", headers=alice,
                        json={"ticker": "RELIANCE.NS", "kind": "price",
                              "op": ">", "value": 9999})
        assert r.status_code == 201, r.text
        assert "RELIANCE" not in str(client.get("/api/v1/alerts", headers=bob).json())


class TestAuthentication:
    @pytest.mark.parametrize("path", [
        "/api/v1/notes/RELIANCE.NS", "/api/v1/watchlists",
        "/api/v1/portfolio", "/api/v1/alerts",
    ])
    def test_every_personal_surface_requires_a_session(self, client, path):
        assert client.get(path).status_code in (401, 403)

    @pytest.mark.parametrize("path", [
        "/api/v1/notes/RELIANCE.NS", "/api/v1/watchlists",
        "/api/v1/portfolio", "/api/v1/alerts",
    ])
    def test_a_forged_token_is_rejected(self, client, path):
        bad = {"Authorization": "Bearer not.a.real.token"}
        assert client.get(path, headers=bad).status_code in (401, 403)

    def test_the_username_cannot_be_supplied_BY_THE_CLIENT(self, client, two_users):
        # The identity must come from the verified token and nowhere else. If
        # a query parameter could redirect the lookup, every isolation test
        # above would still pass while the data was wide open.
        alice, bob = two_users
        client.put("/api/v1/notes/HDFCBANK.NS", headers=alice,
                   json={"text": "alice-only"})
        for attempt in ("?username=alice", "?user=alice", "?as=alice"):
            r = client.get(f"/api/v1/notes/HDFCBANK.NS{attempt}", headers=bob)
            assert "alice-only" not in (r.json().get("text") or ""), attempt
