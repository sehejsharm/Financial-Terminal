"""Multi-portfolio, CSV import, realized P&L, and history endpoints."""
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
    tmp = tmp_path_factory.mktemp("pmulti")
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
def h(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_default_portfolio_exists_and_crud(client, h):
    ports = client.get("/api/v1/portfolio/list", headers=h).json()
    assert len(ports) == 1 and ports[0]["name"] == "Main"

    r = client.post("/api/v1/portfolio/create", json={"name": "Long-term"},
                    headers=h)
    assert r.status_code == 201
    pid = r.json()["id"]
    assert len(client.get("/api/v1/portfolio/list", headers=h).json()) == 2

    # Positions land in the addressed portfolio only.
    r = client.post("/api/v1/portfolio/positions",
                    json={"ticker": "TCS.NS", "qty": 10, "cost": 3000, "pid": pid},
                    headers=h)
    assert r.status_code == 201
    ports = client.get("/api/v1/portfolio/list", headers=h).json()
    by_id = {p["id"]: p for p in ports}
    assert by_id[pid]["positions"] == 1

    r = client.delete(f"/api/v1/portfolio/{pid}", headers=h)
    assert r.status_code == 204
    # The last remaining portfolio can't be deleted.
    last = client.get("/api/v1/portfolio/list", headers=h).json()[0]["id"]
    assert client.delete(f"/api/v1/portfolio/{last}", headers=h).status_code == 400


def test_csv_import_bulk(client, h):
    rows = [{"ticker": "RELIANCE.NS", "qty": 5, "cost": 2900},
            {"ticker": "INFY.NS", "qty": 12, "cost": 1500}]
    r = client.post("/api/v1/portfolio/import", json={"positions": rows},
                    headers=h)
    assert r.status_code == 201
    assert r.json()["added"] == 2
    ports = client.get("/api/v1/portfolio/list", headers=h).json()
    assert ports[0]["positions"] == 2


def test_close_with_sell_price_records_realized(client, h):
    pos = client.post("/api/v1/portfolio/positions",
                      json={"ticker": "HDFCBANK.NS", "qty": 4, "cost": 1500},
                      headers=h).json()
    r = client.delete(
        f"/api/v1/portfolio/positions/{pos['id']}?sell_price=1600", headers=h)
    assert r.status_code == 200
    ev = r.json()["realized"]
    assert ev["pnl"] == pytest.approx((1600 - 1500) * 4)

    # History endpoint exists and returns the portfolio identity.
    hist = client.get("/api/v1/portfolio/history", headers=h).json()
    assert hist["portfolio"]["name"] == "Main"
    assert isinstance(hist["points"], list)


def test_legacy_doc_migrates(client, h, tmp_path_factory):
    """A pre-existing single-portfolio doc gains the portfolios shape without
    losing positions."""
    from backend.routes.portfolio import _doc
    from backend.storage import get_storage
    get_storage().save_user_doc("portfolios", "legacyuser",
                                {"positions": [{"id": "x", "ticker": "AAPL",
                                                "qty": 1, "cost": 100}]})
    doc = _doc("legacyuser")
    assert doc["portfolios"][0]["name"] == "Main"
    assert doc["portfolios"][0]["positions"][0]["ticker"] == "AAPL"
