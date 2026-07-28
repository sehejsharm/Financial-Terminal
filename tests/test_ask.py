"""'Ask Motherboard' retrieval copilot.

The valuable behaviour here is what the endpoint REFUSES to do, so that's
what these tests pin: context is assembled only from the caller's own data,
blocks the user has nothing in are absent rather than fabricated, and a user
with no data at all gets an honest "I have no data" instead of a model
answering from memory.
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
    tmp = tmp_path_factory.mktemp("ask")
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


USER = {"username": "admin"}


def test_requires_auth(client):
    r = client.post("/api/v1/ai/ask", json={"question": "what do I hold?"})
    assert r.status_code in (401, 403)


def test_rejects_an_empty_or_oversized_question(client, auth):
    assert client.post("/api/v1/ai/ask", json={"question": "a"},
                       headers=auth).status_code == 422
    assert client.post("/api/v1/ai/ask", json={"question": "x" * 501},
                       headers=auth).status_code == 422


# ── context assembly ──────────────────────────────────────────────────────

def test_context_is_empty_for_a_user_with_no_data(client, auth):
    """A fresh account has nothing to answer from, and the builder must say so
    by returning no blocks rather than inventing an empty-looking one."""
    from backend.routes.ai import build_ask_context
    blocks = build_ask_context(USER, None)
    labels = [lbl for lbl, _ in blocks]
    # Macro may or may not be reachable (FRED is a network call); everything
    # that depends on USER data must be absent.
    assert "Portfolio" not in labels
    assert "Watchlists" not in labels
    assert "Alerts" not in labels


def test_no_data_answer_does_not_call_the_model(client, auth, monkeypatch):
    """With nothing retrieved, the endpoint returns a fixed honest message.
    If it ever reaches the LLM instead, this blows up — which is the point:
    an unGrounded model answer is exactly the failure mode to prevent."""
    import backend.routes.ai as ai_mod

    def _boom(*a, **k):
        raise AssertionError("model must not be called with no context")

    monkeypatch.setattr(ai_mod.ai_analyst, "_call", _boom)
    monkeypatch.setattr(ai_mod.ai_analyst, "is_available", lambda: True)
    monkeypatch.setattr(ai_mod, "build_ask_context", lambda *a, **k: [])

    r = client.post("/api/v1/ai/ask", json={"question": "what do I hold?"},
                    headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert body["sources"] == []
    assert "no data" in body["markdown"].lower()


def test_portfolio_block_appears_once_a_position_exists(client, auth):
    from backend.routes.ai import build_ask_context
    r = client.post("/api/v1/portfolio/positions",
                    json={"ticker": "RELIANCE.NS", "qty": 10, "cost": 2500},
                    headers=auth)
    assert r.status_code == 201, r.text

    blocks = dict(build_ask_context(USER, None))
    assert "Portfolio" in blocks
    assert "RELIANCE.NS" in blocks["Portfolio"]


def test_watchlist_and_alert_blocks_appear_once_they_exist(client, auth):
    from backend.routes.ai import build_ask_context
    client.post("/api/v1/watchlists",
                json={"name": "Energy", "tickers": ["ONGC.NS", "IOC.NS"]},
                headers=auth)
    client.post("/api/v1/alerts",
                json={"kind": "price", "ticker": "TCS.NS", "op": ">",
                      "value": 4000},
                headers=auth)

    blocks = dict(build_ask_context(USER, None))
    assert "Energy" in blocks.get("Watchlists", "")
    assert "ONGC.NS" in blocks.get("Watchlists", "")
    assert "TCS.NS" in blocks.get("Alerts", "")


def test_value_chain_block_only_appears_for_a_mapped_ticker(client, auth,
                                                            monkeypatch, tmp_path):
    import json

    import backend.routes.value_chain as vc
    import backend.routes.ai as ai_mod

    path = tmp_path / "vc_history.jsonl"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "ticker": "RELIANCE.NS", "ts": "2026-07-01T00:00:00Z",
            "data": {"suppliers": [{"name": "Saudi Aramco"}],
                     "customers": [{"name": "Retail consumers"}],
                     "competitors": []},
        }) + "\n")
    monkeypatch.setattr(vc, "HISTORY_PATH", path)

    assert ai_mod._ctx_value_chain("RELIANCE.NS") is not None
    assert "Saudi Aramco" in ai_mod._ctx_value_chain("RELIANCE.NS")
    # A name that was never mapped gets no block at all.
    assert ai_mod._ctx_value_chain("TCS.NS") is None
    assert ai_mod._ctx_value_chain("") is None


def test_context_blocks_are_labelled_with_their_source_module(client, auth):
    """Every block carries the module label the prompt tells the model to
    cite; an unlabelled block would produce an uncheckable answer."""
    from backend.routes.ai import build_ask_context
    blocks = build_ask_context(USER, None)
    assert blocks, "the portfolio added above should produce at least one block"
    for label, text in blocks:
        assert isinstance(label, str) and label.strip()
        assert isinstance(text, str) and text.strip()


def test_answer_reports_the_sources_it_was_given(client, auth, monkeypatch):
    import backend.routes.ai as ai_mod
    monkeypatch.setattr(ai_mod.ai_analyst, "is_available", lambda: True)
    seen = {}

    def _fake(prompt, **kw):
        seen["prompt"] = prompt
        return "You hold RELIANCE.NS [Portfolio]."

    monkeypatch.setattr(ai_mod.ai_analyst, "_call", _fake)
    r = client.post("/api/v1/ai/ask",
                    json={"question": "what do I hold?"}, headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert "Portfolio" in body["sources"]
    # The retrieved context really is in the prompt, and the refusal rule with it.
    assert "RELIANCE.NS" in seen["prompt"]
    assert "ONLY from the context above" in seen["prompt"]


def test_503_when_no_ai_provider_is_configured(client, auth, monkeypatch):
    import backend.routes.ai as ai_mod
    monkeypatch.setattr(ai_mod.ai_analyst, "is_available", lambda: False)
    r = client.post("/api/v1/ai/ask", json={"question": "anything?"},
                    headers=auth)
    assert r.status_code == 503
