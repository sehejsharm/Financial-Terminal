"""Streaming spine: market-session gating, hub diff-only emit, and the
WebSocket contract (auth, subscribe → snapshot, published tick → delta)."""
from __future__ import annotations

import importlib
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


# ── session hours ─────────────────────────────────────────────────────────

def test_market_for_symbol():
    from backend.stream import session
    assert session.market_for_symbol("RELIANCE.NS") == "NSE"
    assert session.market_for_symbol("^NSEI") == "NSE"
    assert session.market_for_symbol("^INDIAVIX") == "NSE"
    assert session.market_for_symbol("AAPL") == "US"
    assert session.market_for_symbol("^GSPC") == "US"


def test_nse_session_hours():
    from backend.stream import session
    # 2026-01-05 is a Monday. 10:00 IST = 04:30 UTC → open; 16:00 IST closed.
    open_utc = datetime(2026, 1, 5, 4, 30, tzinfo=timezone.utc)
    closed_utc = datetime(2026, 1, 5, 10, 30, tzinfo=timezone.utc)  # 16:00 IST
    assert session.is_open("NSE", open_utc) is True
    assert session.is_open("NSE", closed_utc) is False
    # Saturday is always closed.
    sat = datetime(2026, 1, 3, 4, 30, tzinfo=timezone.utc)
    assert session.is_open("NSE", sat) is False


def test_cadence_faster_when_open():
    from backend.stream import session
    open_utc = datetime(2026, 1, 5, 4, 30, tzinfo=timezone.utc)
    closed_utc = datetime(2026, 1, 5, 10, 30, tzinfo=timezone.utc)
    assert session.cadence_ms("NSE", open_utc) < session.cadence_ms("NSE", closed_utc)
    assert session.cadence_ms("NSE", closed_utc) == session.CADENCE_CLOSED_MS


# ── hub diff-only emit ─────────────────────────────────────────────────────

def test_hub_emits_only_changed_fields():
    from backend.stream import hub
    conn = hub.Connection()
    hub.register(conn)
    hub.add_symbols(conn, ["RELIANCE.NS"])
    assert "RELIANCE.NS" in hub.active_symbols()

    hub.publish("RELIANCE.NS", {"ltp": 100.0, "chgPct": 1.0, "ts": 1})
    assert conn.queue.qsize() == 1
    frame = conn.queue.get_nowait()
    assert frame["t"] == "px"
    assert frame["d"][0]["ltp"] == 100.0

    # Unchanged → no frame emitted.
    hub.publish("RELIANCE.NS", {"ltp": 100.0, "chgPct": 1.0, "ts": 2})
    assert conn.queue.qsize() == 0

    # Only ltp moved → delta carries ltp (+ s/ts), not chgPct.
    hub.publish("RELIANCE.NS", {"ltp": 100.5, "chgPct": 1.0, "ts": 3})
    d = conn.queue.get_nowait()["d"][0]
    assert d["ltp"] == 100.5
    assert "chgPct" not in d

    hub.unregister(conn)
    assert "RELIANCE.NS" not in hub.active_symbols()


def test_hub_refcount_union():
    from backend.stream import hub
    a, b = hub.Connection(), hub.Connection()
    hub.register(a); hub.register(b)
    hub.add_symbols(a, ["TCS.NS"])
    hub.add_symbols(b, ["TCS.NS"])
    assert hub.active_symbols().count("TCS.NS") == 1  # coalesced
    hub.remove_symbols(a, ["TCS.NS"])
    assert "TCS.NS" in hub.active_symbols()   # b still wants it
    hub.remove_symbols(b, ["TCS.NS"])
    assert "TCS.NS" not in hub.active_symbols()
    hub.unregister(a); hub.unregister(b)


# ── websocket contract ─────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    tmp = tmp_path_factory.mktemp("stream")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeymodule.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    monkeymodule.setenv("BACKEND_JWT_SECRET",
                        "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    import lib.auth as lib_auth
    monkeymodule.setattr(lib_auth, "DATA_DIR", Path(tmp))
    monkeymodule.setattr(lib_auth, "USERS_PATH", Path(tmp) / "users.json")
    monkeymodule.setattr(lib_auth, "INITIAL_PW_PATH", Path(tmp) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))
    from backend import app as app_mod
    importlib.reload(app_mod)
    return TestClient(app_mod.app)


def _token(client) -> str:
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    return r.json()["access_token"]


def test_stream_requires_auth(client):
    # SSE without a token → 401. WS without a token → closed before accept.
    assert client.get("/api/v1/stream/sse?symbols=RELIANCE.NS").status_code == 401
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/stream?token=bogus"):
            pass


def test_stream_ws_subscribe_and_delta(client):
    tok = _token(client)
    from backend.stream import hub
    with client.websocket_connect(f"/api/v1/stream?token={tok}") as ws:
        assert ws.receive_json()["t"] == "stat"       # first frame
        ws.send_json({"op": "sub", "symbols": ["RELIANCE.NS"]})
        hub.publish("RELIANCE.NS", {"ltp": 2945.5, "chgPct": 0.42, "ts": 99})
        got = None
        for _ in range(6):
            m = ws.receive_json()
            if m["t"] == "px":
                got = m
                break
        assert got and got["d"][0]["s"] == "RELIANCE.NS"
        assert got["d"][0]["ltp"] == 2945.5


def test_stream_health_endpoint(client):
    r = client.get("/api/v1/stream/health")
    assert r.status_code == 200
    body = r.json()
    assert "connections" in body and "symbols" in body and "marketOpen" in body
