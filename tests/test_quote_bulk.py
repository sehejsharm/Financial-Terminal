"""quote-bulk: the POST form, and the cap that must refuse rather than truncate.

The GET form carries symbols in the query string. A whole dashboard board is
41 tickers, and putting that in a URL hands the decision about how many quotes
you get to whichever proxy has the shortest length limit. POST moves them into
the body.

The cap matters more than it looks. It used to be `[:30]` — a silent
truncation. That was survivable only while the client sent one symbol per
request; the moment seeding was coalesced into a single call, a silent
truncation would have turned a performance fix into missing data, with blank
cells and nothing on screen to say why. So the cap now refuses.
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
    tmp = tmp_path_factory.mktemp("bulk")
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
def auth(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(autouse=True)
def _no_providers(monkeypatch):
    """Answer every symbol locally.

    The route's job here is routing, shaping and capping — not fetching. Going
    to a provider would make this a test of the network.
    """
    from backend.routes import market
    monkeypatch.setattr(
        market, "_bulk_quotes",
        lambda syms: {s: {"symbol": s, "price": 1.0, "prev_close": 1.0,
                          "change_pct": 0.0, "currency": "INR"} for s in syms})


MAX = 120   # mirrors backend.routes.market._MAX_BULK_SYMBOLS


class TestPostForm:
    def test_accepts_symbols_in_the_body(self, client, auth):
        r = client.post("/api/v1/market/quote-bulk", headers=auth,
                        json={"symbols": ["RELIANCE.NS", "TCS.NS", "INFY.NS"]})
        assert r.status_code == 200, r.text
        assert set(r.json()) == {"RELIANCE.NS", "TCS.NS", "INFY.NS"}

    def test_carries_a_whole_board_in_ONE_request(self, client, auth):
        # 41 is the live dashboard's board size — the case the coalescer
        # creates and the old 30-symbol cap would have silently halved.
        syms = [f"SYM{i}.NS" for i in range(41)]
        r = client.post("/api/v1/market/quote-bulk", headers=auth,
                        json={"symbols": syms})
        assert r.status_code == 200, r.text
        assert len(r.json()) == 41, "symbols went missing from a single call"

    def test_normalises_case_and_whitespace(self, client, auth):
        r = client.post("/api/v1/market/quote-bulk", headers=auth,
                        json={"symbols": [" reliance.ns ", "tcs.NS"]})
        assert r.status_code == 200
        assert set(r.json()) == {"RELIANCE.NS", "TCS.NS"}

    def test_requires_a_session(self, client):
        r = client.post("/api/v1/market/quote-bulk",
                        json={"symbols": ["RELIANCE.NS"]})
        assert r.status_code in (401, 403)


class TestTheCapRefusesRatherThanTruncating:
    def test_at_the_limit_is_fine(self, client, auth):
        syms = [f"S{i}.NS" for i in range(MAX)]
        r = client.post("/api/v1/market/quote-bulk", headers=auth,
                        json={"symbols": syms})
        assert r.status_code == 200, r.text
        assert len(r.json()) == MAX

    def test_over_the_limit_is_REFUSED_not_silently_cut(self, client, auth):
        # The whole point. A 400 is recoverable; 121 symbols in and 120 out is
        # a blank cell with no explanation.
        syms = [f"S{i}.NS" for i in range(MAX + 1)]
        r = client.post("/api/v1/market/quote-bulk", headers=auth,
                        json={"symbols": syms})
        assert r.status_code in (400, 422), (
            f"expected a refusal, got {r.status_code} — check for truncation")

    def test_an_empty_list_is_rejected(self, client, auth):
        r = client.post("/api/v1/market/quote-bulk", headers=auth,
                        json={"symbols": []})
        assert r.status_code in (400, 422)


class TestGetFormStillWorks:
    def test_the_query_string_form_is_unchanged(self, client, auth):
        # Nothing may break: anything already pointed at GET keeps working.
        r = client.get("/api/v1/market/quote-bulk?symbols=RELIANCE.NS,TCS.NS",
                       headers=auth)
        assert r.status_code == 200, r.text
        assert set(r.json()) == {"RELIANCE.NS", "TCS.NS"}

    def test_get_also_refuses_an_oversized_list(self, client, auth):
        syms = ",".join(f"S{i}.NS" for i in range(MAX + 1))
        r = client.get(f"/api/v1/market/quote-bulk?symbols={syms}", headers=auth)
        assert r.status_code in (400, 422)
