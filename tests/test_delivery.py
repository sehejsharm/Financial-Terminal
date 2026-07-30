"""Alert delivery: notify settings store, per-user prefs, Telegram linking
endpoints, and admin gating for the server-side delivery config."""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lib import notify


@pytest.fixture(scope="module")
def monkeymodule():
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def client(tmp_path_factory, monkeymodule):
    tmp = tmp_path_factory.mktemp("delivery")
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

    # Point the notify settings file at the temp dir too.
    monkeymodule.setattr(notify, "_DATA_DIR", Path(tmp))
    monkeymodule.setattr(notify, "_SETTINGS_PATH", Path(tmp) / "notify_settings.json")

    from backend import storage as st_mod
    st_mod._storage = st_mod.JSONStore(Path(tmp))

    from backend import app as app_mod
    importlib.reload(app_mod)
    return TestClient(app_mod.app)


@pytest.fixture(scope="module")
def admin_headers(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "test-pw-123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def user_headers(client, admin_headers):
    r = client.post("/api/v1/admin/users",
                    json={"username": "bob", "password": "bob-pw-12345", "role": "user"},
                    headers=admin_headers)
    assert r.status_code in (200, 201), r.text
    r = client.post("/api/v1/auth/login",
                    json={"username": "bob", "password": "bob-pw-12345"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ── notify settings store ────────────────────────────────────────────────

def test_settings_roundtrip_and_masking(client):
    notify.save_settings({"smtp_host": "smtp.example.com", "smtp_pass": "s3cret",
                          "telegram_bot_token": "123:abc"})
    s = notify.load_settings()
    assert s["smtp_host"] == "smtp.example.com"
    masked = notify.masked_settings()
    assert masked["smtp_pass"] == "•••set•••"
    assert masked["telegram_bot_token"] == "•••set•••"
    assert "s3cret" not in str(masked)
    # Blank clears a key.
    notify.save_settings({"smtp_pass": ""})
    assert "smtp_pass" not in notify.load_settings()
    notify.save_settings({"smtp_host": "", "telegram_bot_token": ""})


def test_cfg_prefers_env(client, monkeypatch):
    notify.save_settings({"smtp_host": "from-file.example"})
    monkeypatch.setenv("SMTP_HOST", "from-env.example")
    assert notify._cfg("SMTP_HOST") == "from-env.example"
    monkeypatch.delenv("SMTP_HOST")
    assert notify._cfg("SMTP_HOST") == "from-file.example"
    notify.save_settings({"smtp_host": ""})


# ── per-user prefs + gating ──────────────────────────────────────────────

def test_set_delivery_email_validates(client, user_headers):
    r = client.put("/api/v1/alerts/delivery", json={"email": "not-an-email"},
                   headers=user_headers)
    assert r.status_code == 400
    r = client.put("/api/v1/alerts/delivery", json={"email": "bob@example.com"},
                   headers=user_headers)
    assert r.status_code == 200
    cfg = client.get("/api/v1/alerts/push/config", headers=user_headers).json()
    assert cfg["my_email"] == "bob@example.com"
    assert cfg["telegram_linked"] is False


def test_telegram_start_requires_token(client, user_headers):
    notify.save_settings({"telegram_bot_token": ""})
    r = client.post("/api/v1/alerts/telegram/start", headers=user_headers)
    assert r.status_code == 400  # channel not configured


def test_server_config_admin_only(client, user_headers, admin_headers):
    r = client.get("/api/v1/alerts/delivery/server", headers=user_headers)
    assert r.status_code == 403
    r = client.get("/api/v1/alerts/delivery/server", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert "settings" in body and "channels" in body

    r = client.put("/api/v1/alerts/delivery/server",
                   json={"smtp_host": "smtp.gmail.com", "smtp_port": "587"},
                   headers=admin_headers)
    assert r.status_code == 200
    assert notify.load_settings()["smtp_host"] == "smtp.gmail.com"
    # Masked placeholder round-trips without clobbering the stored secret.
    notify.save_settings({"smtp_pass": "real-secret"})
    r = client.put("/api/v1/alerts/delivery/server",
                   json={"smtp_pass": "•••set•••"}, headers=admin_headers)
    assert r.status_code == 200
    assert notify.load_settings()["smtp_pass"] == "real-secret"
    notify.save_settings({k: "" for k in notify.SETTING_KEYS})


# ── AI prompt number formatting ──────────────────────────────────────────

def test_ai_normalize_units_humanizes():
    from backend.routes.ai import _normalize_units
    f = _normalize_units({
        "currency": "INR", "market_cap": 17768137097216,
        "dividend_yield": 0.099750005, "debt_to_equity": 36.65,
        "shares_outstanding": 6766110000, "trailing_pe": 27.123456,
    })
    assert f["market_cap"] == "₹17.77T"
    assert f["dividend_yield"] == "9.98%"
    assert f["debt_to_equity"] == "0.37x"
    assert f["shares_outstanding"] == "6.77B"   # count — no currency sign
    assert f["trailing_pe"] == 27.12


def test_ai_analysis_payload_exposes_the_figures_the_model_was_GIVEN():
    """An analysis whose inputs are hidden is unfalsifiable.

    A reader cannot check a claim about margins without knowing which margin
    the model was handed, or whether it was handed one at all — a confident
    sentence written off a missing field is the failure mode, and it is
    invisible unless the inputs are shown.
    """
    from backend.routes.ai import _analysis_payload, _normalize_units

    f = _normalize_units({
        "currency": "INR", "name": "Reliance Industries Ltd",
        "market_cap": 17768137097216, "trailing_pe": 27.12,
        "profit_margin": 0.0812, "roe": None, "sector": "",
    })
    p = _analysis_payload("RELIANCE.NS", "## Bull case\n\nsomething", f)

    assert p["ticker"] == "RELIANCE.NS"
    assert p["markdown"].startswith("## Bull case")
    # The figures, in the same human form the prompt saw.
    assert p["inputs"]["market_cap"] == "₹17.77T"
    assert p["inputs"]["profit_margin"] == "8.12%"
    # Provenance and empty fields are not "figures the analysis is based on".
    assert "currency" not in p["inputs"]
    assert "name" not in p["inputs"]
    # A field the provider didn't supply must be ABSENT rather than listed as
    # an input, so the reader can see the model had nothing to go on.
    assert "roe" not in p["inputs"]
    assert "sector" not in p["inputs"]
    # Stamped, so a cached narrative can't be mistaken for a fresh one.
    assert p["generated_at"].endswith("+00:00")
