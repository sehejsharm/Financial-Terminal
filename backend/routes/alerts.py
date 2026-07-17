"""Price / valuation / macro alerts with a background evaluator.

Conditions are evaluated server-side every ~60 s (backend/app.py starts the
loop) against the same cached provider layer the UI uses. Triggered alerts
deactivate and land in the user's event feed, surfaced by the header bell.

Delivery: in-app always; email (SMTP_* env) and browser push (VAPID_* env +
per-device subscriptions stored via /alerts/push/subscribe) when configured
— see lib/notify.py and deploy/.env.example.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend import auth, providers
from backend.storage import get_storage
from lib import notify

router = APIRouter(prefix="/alerts", tags=["alerts"])
log = logging.getLogger("motherboard.alerts")
_MAX_PUSH_SUBS = 5

KINDS = {"price", "pe", "spread_10y2y", "move", "volume_spike"}
_TICKER_KINDS = {"price", "pe", "move", "volume_spike"}
_MAX_EVENTS = 50
_MAX_ALERTS = 40


class AlertCreate(BaseModel):
    kind: str = Field(..., description="price | pe | spread_10y2y")
    ticker: str | None = Field(None, max_length=24)
    op: str = Field(..., description="> or <")
    value: float


def _doc(username: str) -> dict:
    return get_storage().user_doc("alerts", username, {"alerts": [], "events": []}) \
        or {"alerts": [], "events": []}


@router.get("")
def list_alerts(user: dict = Depends(auth.current_user)):
    return _doc(user["username"])


@router.post("", status_code=201)
def create(body: AlertCreate, user: dict = Depends(auth.current_user)):
    if body.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(KINDS)}")
    if body.op not in (">", "<"):
        raise HTTPException(400, "op must be '>' or '<'")
    if body.kind in _TICKER_KINDS and not (body.ticker or "").strip():
        raise HTTPException(400, f"'{body.kind}' alerts need a ticker")
    doc = _doc(user["username"])
    if len(doc["alerts"]) >= _MAX_ALERTS:
        raise HTTPException(400, f"Alert limit reached ({_MAX_ALERTS}).")
    from lib.resolve import canonicalize
    raw_ticker = body.ticker.strip().upper() if body.ticker else None
    alert = {
        "id": str(uuid.uuid4()), "kind": body.kind,
        "ticker": (canonicalize(raw_ticker) or raw_ticker) if raw_ticker else None,
        "op": body.op, "value": body.value, "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "triggered_at": None,
    }
    doc["alerts"].append(alert)
    get_storage().save_user_doc("alerts", user["username"], doc)
    return alert


@router.delete("/{alert_id}", status_code=204)
def delete(alert_id: str, user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    before = len(doc["alerts"])
    doc["alerts"] = [a for a in doc["alerts"] if a.get("id") != alert_id]
    if len(doc["alerts"]) == before:
        raise HTTPException(404, "Alert not found")
    get_storage().save_user_doc("alerts", user["username"], doc)


@router.get("/events")
def events(user: dict = Depends(auth.current_user)):
    """Triggered-alert feed, newest first (header bell polls this)."""
    return list(reversed(_doc(user["username"])["events"]))


# ── delivery channels (email + telegram + web push) ──────────────────────

class PushSubscription(BaseModel):
    endpoint: str = Field(..., max_length=1000)
    keys: dict = Field(default_factory=dict)


class DeliveryPrefs(BaseModel):
    email: str | None = Field(None, max_length=254)


class ServerDeliveryConfig(BaseModel):
    smtp_host: str | None = Field(None, max_length=200)
    smtp_port: str | None = Field(None, max_length=8)
    smtp_user: str | None = Field(None, max_length=200)
    smtp_pass: str | None = Field(None, max_length=200)
    smtp_from: str | None = Field(None, max_length=200)
    alert_email_to: str | None = Field(None, max_length=254)
    telegram_bot_token: str | None = Field(None, max_length=100)


def _prefs(doc: dict) -> dict:
    return doc.setdefault("delivery", {"email": None, "telegram_chat_id": None,
                                       "telegram_code": None})


@router.get("/push/config")
def push_config(user: dict = Depends(auth.current_user)):
    """Which delivery channels are configured server-side (+ the VAPID
    public key the browser needs to subscribe) + this user's prefs."""
    ch = notify.channels()
    prefs = _prefs(_doc(user["username"]))
    return {**ch, "vapid_public_key": notify.public_key(),
            "my_email": prefs.get("email"),
            "telegram_linked": bool(prefs.get("telegram_chat_id"))}


@router.put("/delivery")
def set_delivery(body: DeliveryPrefs, user: dict = Depends(auth.current_user)):
    """Per-user delivery preferences (currently: the alert email address)."""
    email = (body.email or "").strip()
    if email and ("@" not in email or "." not in email.split("@")[-1]):
        raise HTTPException(400, "That doesn't look like an email address.")
    doc = _doc(user["username"])
    _prefs(doc)["email"] = email or None
    get_storage().save_user_doc("alerts", user["username"], doc)
    return {"ok": True, "email": email or None}


@router.post("/telegram/start")
def telegram_start(user: dict = Depends(auth.current_user)):
    """Begin Telegram linking: returns the bot's @username and a one-time
    code the user sends to the bot from their phone."""
    if not notify.telegram_configured():
        raise HTTPException(400, "Telegram delivery is not configured yet — "
                                 "ask the admin to add a bot token in "
                                 "Alerts → Delivery setup.")
    code = "MB-" + uuid.uuid4().hex[:6].upper()
    doc = _doc(user["username"])
    _prefs(doc)["telegram_code"] = code
    get_storage().save_user_doc("alerts", user["username"], doc)
    return {"bot": notify.telegram_bot_username(), "code": code}


@router.post("/telegram/verify")
def telegram_verify(user: dict = Depends(auth.current_user)):
    """Complete Telegram linking: look for the code among the bot's recent
    messages and remember the sender's chat id."""
    doc = _doc(user["username"])
    prefs = _prefs(doc)
    code = prefs.get("telegram_code")
    if not code:
        raise HTTPException(400, "Start the linking flow first.")
    chat_id = notify.telegram_find_chat(code)
    if chat_id is None:
        raise HTTPException(404, "Couldn't find your message yet — send the "
                                 "code to the bot on Telegram, then retry.")
    prefs["telegram_chat_id"] = chat_id
    prefs["telegram_code"] = None
    get_storage().save_user_doc("alerts", user["username"], doc)
    notify.send_telegram(chat_id, "✅ Linked! Motherboard Terminal alerts "
                                  "will arrive in this chat.")
    return {"ok": True}


@router.delete("/telegram", status_code=204)
def telegram_unlink(user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    _prefs(doc)["telegram_chat_id"] = None
    get_storage().save_user_doc("alerts", user["username"], doc)


# ── server-side delivery config (master admin, edited from the web UI so
#    no shell/env access is ever needed) ────────────────────────────────────

def _require_admin(user: dict) -> None:
    if user.get("role") != "master_admin":
        raise HTTPException(403, "Master admin only.")


@router.get("/delivery/server")
def get_server_config(user: dict = Depends(auth.current_user)):
    _require_admin(user)
    return {"settings": notify.masked_settings(), "channels": notify.channels(),
            "telegram_bot": notify.telegram_bot_username() if notify.telegram_configured() else None}


@router.put("/delivery/server")
def set_server_config(body: ServerDeliveryConfig,
                      user: dict = Depends(auth.current_user)):
    _require_admin(user)
    updates = {k: v for k, v in body.model_dump().items()
               if v is not None and not str(v).startswith("•••")}
    notify.save_settings(updates)
    return {"ok": True, "channels": notify.channels()}


@router.post("/push/subscribe", status_code=201)
def push_subscribe(body: PushSubscription,
                   user: dict = Depends(auth.current_user)):
    """Register this browser for push delivery (per-device, capped)."""
    doc = _doc(user["username"])
    subs = doc.setdefault("push_subs", [])
    subs[:] = [s for s in subs if s.get("endpoint") != body.endpoint]
    subs.append({"endpoint": body.endpoint, "keys": body.keys})
    doc["push_subs"] = subs[-_MAX_PUSH_SUBS:]
    get_storage().save_user_doc("alerts", user["username"], doc)
    return {"ok": True, "devices": len(doc["push_subs"])}


@router.post("/test")
def test_delivery(user: dict = Depends(auth.current_user)):
    """Fire a test notification through every configured channel."""
    msg = "Test alert from Motherboard Terminal — delivery is working."
    doc = _doc(user["username"])
    prefs = _prefs(doc)
    results = {"email": None, "push": None, "telegram": None}
    if notify.email_configured():
        results["email"] = notify.send_email("Motherboard test alert", msg,
                                             to=prefs.get("email"))
    if notify.telegram_configured() and prefs.get("telegram_chat_id"):
        results["telegram"] = notify.send_telegram(prefs["telegram_chat_id"], msg)
    subs = doc.get("push_subs", [])
    if notify.push_configured() and subs:
        ok = [notify.send_push(s, "Motherboard Terminal", msg) for s in subs]
        results["push"] = any(ok)
    return {"channels": notify.channels(),
            "devices": len(subs), "results": results}


def _deliver(username: str, doc: dict, message: str) -> None:
    """Fan a triggered alert out to every configured channel. Dead push
    subscriptions are pruned in place (caller saves the doc)."""
    try:
        prefs = doc.get("delivery") or {}
        if notify.email_configured():
            notify.send_email(f"Motherboard alert: {message}", message,
                              to=prefs.get("email"))
        if notify.telegram_configured() and prefs.get("telegram_chat_id"):
            notify.send_telegram(prefs["telegram_chat_id"],
                                 f"🔔 {message}")
        subs = doc.get("push_subs", [])
        if notify.push_configured() and subs:
            doc["push_subs"] = [
                s for s in subs
                if notify.send_push(s, "Motherboard alert", message)
            ]
    except Exception:
        log.exception("alert delivery failed for %s", username)


# ── evaluator (called from the background loop in backend/app.py) ───────────

def _current_value(alert: dict) -> float | None:
    try:
        if alert["kind"] == "price":
            q = providers.quote(alert["ticker"])
            return q.get("price") if q else None
        if alert["kind"] == "move":
            # Absolute intraday % move — used for "big move on this name"
            # alerts (incl. value-chain counterparty watches).
            q = providers.quote(alert["ticker"])
            cp = q.get("change_pct") if q else None
            return abs(cp) if cp is not None else None
        if alert["kind"] == "pe":
            s = providers.snapshot(alert["ticker"], quota_safe=True)
            return s.get("trailing_pe") if s else None
        if alert["kind"] == "volume_spike":
            s = providers.snapshot(alert["ticker"], quota_safe=True) or {}
            vol, avg = s.get("volume"), s.get("avg_volume")
            return (vol / avg) if (vol and avg) else None
        if alert["kind"] == "spread_10y2y":
            from lib.macro import get_indicator
            ind = get_indicator("10Y-2Y spread", "US")
            return ind.get("value")
    except Exception:
        return None
    return None


def _describe(alert: dict, val: float) -> str:
    subject = alert["ticker"] or "10Y-2Y spread"
    metric = {"price": "price", "pe": "P/E", "spread_10y2y": "spread",
              "move": "abs day move %", "volume_spike": "volume vs avg"}[alert["kind"]]
    return (f"{subject} {metric} is {val:.2f} — crossed {alert['op']} "
            f"{alert['value']:g}")


def evaluate_all() -> int:
    """One evaluation pass over every user's active alerts. Returns the
    number of alerts triggered. Values are fetched once per distinct
    condition subject (provider calls are cached), errors never propagate."""
    store = get_storage()
    fired = 0
    for username, doc in store.all_user_docs("alerts").items():
        alerts = (doc or {}).get("alerts", [])
        dirty = False
        for a in alerts:
            if not a.get("active"):
                continue
            val = _current_value(a)
            if val is None:
                continue
            hit = val > a["value"] if a["op"] == ">" else val < a["value"]
            if not hit:
                continue
            a["active"] = False
            a["triggered_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            message = _describe(a, val)
            doc.setdefault("events", []).append({
                "ts": a["triggered_at"], "alert_id": a["id"],
                "message": message, "value": val,
            })
            doc["events"] = doc["events"][-_MAX_EVENTS:]
            _deliver(username, doc, message)
            dirty = True
            fired += 1
            log.info("alert fired for %s: %s", username, message)
        if dirty:
            store.save_user_doc("alerts", username, doc)
    return fired
