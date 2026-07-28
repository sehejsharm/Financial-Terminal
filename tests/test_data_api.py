"""DAPI — personal API tokens and the Excel/Sheets read endpoints.

The security properties are the point of these tests: a long-lived token is
hashed at rest, shown once, scoped to read-only endpoints, and revocable.
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
    tmp = tmp_path_factory.mktemp("dapi")
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
def token(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def api_token(client, auth):
    r = client.post("/api/v1/data/tokens", json={"label": "sheets"},
                    headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


# ── token lifecycle ───────────────────────────────────────────────────────

def test_token_creation_requires_a_logged_in_session(client):
    assert client.post("/api/v1/data/tokens", json={"label": "x"}
                       ).status_code in (401, 403)


def test_created_token_is_returned_exactly_once(client, auth, api_token):
    raw = api_token["token"]
    assert raw.startswith("mb_live_")
    assert len(raw) > 40

    # It never appears again in any listing.
    rows = client.get("/api/v1/data/tokens", headers=auth).json()
    mine = [t for t in rows if t["id"] == api_token["id"]]
    assert len(mine) == 1
    assert "token" not in mine[0]
    assert "hash" not in mine[0]
    assert mine[0]["prefix"] in raw
    assert len(mine[0]["prefix"]) < len(raw)


def test_token_is_hashed_at_rest_not_stored_in_plaintext(client, auth, api_token):
    from backend.routes.data_api import _doc
    rec = next(t for t in _doc("admin")["tokens"] if t["id"] == api_token["id"])
    assert "hash" in rec
    assert rec["hash"] != api_token["token"]
    assert api_token["token"] not in str(rec)


def test_revoked_token_stops_working(client, auth, api_token):
    raw = api_token["token"]
    ok = client.get("/api/v1/data/bdp?tickers=AAPL",
                    headers={"Authorization": f"Bearer {raw}"})
    assert ok.status_code == 200

    assert client.delete(f"/api/v1/data/tokens/{api_token['id']}",
                         headers=auth).status_code == 204
    after = client.get("/api/v1/data/bdp?tickers=AAPL",
                       headers={"Authorization": f"Bearer {raw}"})
    assert after.status_code == 401
    # And revoking it twice is a clean 404, not a crash.
    assert client.delete(f"/api/v1/data/tokens/{api_token['id']}",
                         headers=auth).status_code == 404


def test_a_forged_token_is_rejected(client):
    for bad in ["mb_live_totally-made-up-value-aaaaaaaaaaaaaaaaaa",
                "mb_live_", "not-a-token", ""]:
        r = client.get("/api/v1/data/bdp?tickers=AAPL",
                       headers={"Authorization": f"Bearer {bad}"})
        assert r.status_code == 401, bad


def test_last_used_is_recorded_so_stale_tokens_are_visible(client, auth):
    made = client.post("/api/v1/data/tokens", json={"label": "usage"},
                       headers=auth).json()
    rows = client.get("/api/v1/data/tokens", headers=auth).json()
    assert next(t for t in rows if t["id"] == made["id"])["last_used_at"] is None

    client.get("/api/v1/data/bdp?tickers=AAPL",
               headers={"Authorization": f"Bearer {made['token']}"})
    rows = client.get("/api/v1/data/tokens", headers=auth).json()
    assert next(t for t in rows if t["id"] == made["id"])["last_used_at"] is not None


def test_token_limit_is_enforced(client, auth):
    from backend.routes.data_api import MAX_TOKENS, _doc, _save
    doc = _doc("admin")
    doc["tokens"] = doc["tokens"][:MAX_TOKENS]
    while len(doc["tokens"]) < MAX_TOKENS:
        doc["tokens"].append({"id": f"filler{len(doc['tokens'])}", "label": "f",
                              "prefix": "mb_live_x", "hash": "x",
                              "created_at": "2026-01-01T00:00:00+00:00",
                              "last_used_at": None})
    _save("admin", doc)
    r = client.post("/api/v1/data/tokens", json={"label": "one too many"},
                    headers=auth)
    assert r.status_code == 400
    doc["tokens"] = []
    _save("admin", doc)


# ── scope: the token is READ-ONLY ─────────────────────────────────────────

def test_api_token_cannot_reach_any_other_endpoint(client, api_token):
    """The whole safety argument rests on this: a leaked spreadsheet token
    must not be able to touch the portfolio, alerts or admin surface."""
    h = {"Authorization": f"Bearer {api_token['token']}"}
    for method, path in [
        ("get", "/api/v1/portfolio/summary"),
        ("get", "/api/v1/alerts"),
        ("get", "/api/v1/admin/users"),
        ("get", "/api/v1/watchlists"),
        ("get", "/api/v1/data/tokens"),          # not even its own listing
        ("post", "/api/v1/data/tokens"),         # and it cannot mint more
    ]:
        r = getattr(client, method)(path, headers=h, **({"json": {}} if method == "post" else {}))
        assert r.status_code in (401, 403), f"{method} {path} -> {r.status_code}"


# ── CSV correctness ───────────────────────────────────────────────────────

def test_csv_escaping_never_shifts_columns():
    from backend.routes.data_api import csv_escape, to_csv
    assert csv_escape("Reliance Industries, Ltd") == '"Reliance Industries, Ltd"'
    assert csv_escape('He said "hi"') == '"He said ""hi"""'
    assert csv_escape("line\nbreak") == '"line\nbreak"'
    assert csv_escape(None) == ""
    assert csv_escape(12.5) == "12.5"

    csv = to_csv(["a", "b"], [["x,y", 1]])
    assert csv.splitlines()[1] == '"x,y",1'


def test_bdp_rejects_a_request_with_no_valid_field(client, auth):
    r = client.get("/api/v1/data/bdp?tickers=AAPL&fields=nonsense_field",
                   headers=auth)
    assert r.status_code == 400
    assert "nonsense_field" in r.json()["detail"]


def test_bdp_reports_unknown_fields_rather_than_silently_dropping_them(client, auth):
    r = client.get("/api/v1/data/bdp?tickers=AAPL&fields=price,bogus&format=json",
                   headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert body["fields"] == ["price"]
    assert body["unknown_fields"] == ["bogus"]


def test_bdp_requires_at_least_one_ticker(client, auth):
    assert client.get("/api/v1/data/bdp?tickers=%20%2C%20",
                      headers=auth).status_code == 400


def test_bdp_caps_the_ticker_count(client, auth, monkeypatch):
    import backend.routes.data_api as d
    monkeypatch.setattr(d, "_bdp_row", lambda t: {"price": 1})
    many = ",".join(f"T{i}" for i in range(60))
    r = client.get(f"/api/v1/data/bdp?tickers={many}&fields=price&format=json",
                   headers=auth)
    assert r.status_code == 200
    assert len(r.json()["rows"]) == d.MAX_TICKERS


def test_bdp_csv_has_a_header_row_and_one_row_per_ticker(client, auth, monkeypatch):
    import backend.routes.data_api as d
    monkeypatch.setattr(d, "_bdp_row", lambda t: {"price": 101.5, "name": "N, Inc"})
    r = client.get("/api/v1/data/bdp?tickers=AAA,BBB&fields=name,price",
                   headers=auth)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    lines = r.text.splitlines()
    assert lines[0] == "ticker,name,price"
    assert len(lines) == 3
    assert lines[1] == 'AAA,"N, Inc",101.5'


def test_bdh_emits_a_dated_ohlcv_table(client, auth, monkeypatch):
    from backend import providers
    monkeypatch.setattr(providers, "history", lambda t, p: [
        {"Date": "2026-07-01T00:00:00", "Open": 1, "High": 2, "Low": 0.5,
         "Close": 1.5, "Volume": 1000},
    ])
    r = client.get("/api/v1/data/bdh?ticker=AAA&period=1Y", headers=auth)
    assert r.status_code == 200
    lines = r.text.splitlines()
    assert lines[0] == "date,open,high,low,close,volume"
    assert lines[1].startswith("2026-07-01")

    j = client.get("/api/v1/data/bdh?ticker=AAA&period=1Y&format=json",
                   headers=auth).json()
    assert j["rows"][0]["close"] == 1.5


def test_bdh_survives_a_provider_failure_with_an_empty_table(client, auth, monkeypatch):
    from backend import providers

    def _boom(t, p):
        raise RuntimeError("provider down")

    monkeypatch.setattr(providers, "history", _boom)
    r = client.get("/api/v1/data/bdh?ticker=AAA", headers=auth)
    assert r.status_code == 200
    assert r.text.splitlines() == ["date,open,high,low,close,volume"]


def test_token_can_be_passed_as_a_query_param_for_tools_without_headers(
        client, auth, monkeypatch):
    import backend.routes.data_api as d
    monkeypatch.setattr(d, "_bdp_row", lambda t: {"price": 5})
    made = client.post("/api/v1/data/tokens", json={"label": "q"},
                       headers=auth).json()
    r = client.get(f"/api/v1/data/bdp?tickers=AAA&fields=price&token={made['token']}")
    assert r.status_code == 200
    assert r.text.splitlines()[1] == "AAA,5"


def test_fields_endpoint_documents_what_is_available(client, auth):
    r = client.get("/api/v1/data/fields", headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert "price" in body["bdp_fields"]
    assert "1Y" in body["bdh_periods"]
    # The weekly-bar caveat must travel with the period list.
    assert "WEEKLY" in body["note"]
