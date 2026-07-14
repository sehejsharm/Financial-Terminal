"""Price / valuation / macro alerts with a background evaluator.

Conditions are evaluated server-side every ~60 s (backend/app.py starts the
loop) against the same cached provider layer the UI uses. Triggered alerts
deactivate and land in the user's event feed, surfaced by the header bell.

Delivery is in-app for v1 — browser push needs VAPID keys and email needs
SMTP credentials; both slot into _fire() when configured (see roadmap).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend import auth, providers
from backend.storage import get_storage

router = APIRouter(prefix="/alerts", tags=["alerts"])
log = logging.getLogger("motherboard.alerts")

KINDS = {"price", "pe", "spread_10y2y"}
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
    if body.kind in ("price", "pe") and not (body.ticker or "").strip():
        raise HTTPException(400, f"'{body.kind}' alerts need a ticker")
    doc = _doc(user["username"])
    if len(doc["alerts"]) >= _MAX_ALERTS:
        raise HTTPException(400, f"Alert limit reached ({_MAX_ALERTS}).")
    alert = {
        "id": str(uuid.uuid4()), "kind": body.kind,
        "ticker": body.ticker.strip().upper() if body.ticker else None,
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


# ── evaluator (called from the background loop in backend/app.py) ───────────

def _current_value(alert: dict) -> float | None:
    try:
        if alert["kind"] == "price":
            q = providers.quote(alert["ticker"])
            return q.get("price") if q else None
        if alert["kind"] == "pe":
            s = providers.snapshot(alert["ticker"], quota_safe=True)
            return s.get("trailing_pe") if s else None
        if alert["kind"] == "spread_10y2y":
            from lib.macro import get_indicator
            ind = get_indicator("10Y-2Y spread", "US")
            return ind.get("value")
    except Exception:
        return None
    return None


def _describe(alert: dict, val: float) -> str:
    subject = alert["ticker"] or "10Y-2Y spread"
    metric = {"price": "price", "pe": "P/E", "spread_10y2y": "spread"}[alert["kind"]]
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
            doc.setdefault("events", []).append({
                "ts": a["triggered_at"], "alert_id": a["id"],
                "message": _describe(a, val), "value": val,
            })
            doc["events"] = doc["events"][-_MAX_EVENTS:]
            dirty = True
            fired += 1
            log.info("alert fired for %s: %s", username, _describe(a, val))
        if dirty:
            store.save_user_doc("alerts", username, doc)
    return fired
