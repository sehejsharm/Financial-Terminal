"""Portfolio tracking — multiple named portfolios, positions CRUD, CSV
import, live P&L / allocation summary, realized P&L on close, and a daily
value-history series.

Legacy single-portfolio docs ({"positions": [...]}) migrate lazily into
{"portfolios": [{id, name: "Main", positions, realized, history}]} on first
read — nothing is lost and old clients keep working (pid defaults to the
first portfolio everywhere).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend import auth, providers
from backend.cache import cached
from backend.storage import get_storage

router = APIRouter(prefix="/portfolio", tags=["portfolio"])

_MAX_PORTFOLIOS = 10
_MAX_POSITIONS = 200
_MAX_HISTORY_DAYS = 730


class PositionCreate(BaseModel):
    ticker: str = Field(..., max_length=24)
    qty: float = Field(..., gt=0)
    cost: float = Field(..., ge=0, description="Cost basis per share")
    pid: str | None = None


class PortfolioCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)


class ImportRow(BaseModel):
    ticker: str = Field(..., max_length=24)
    qty: float = Field(..., gt=0)
    cost: float = Field(..., ge=0)


class ImportRequest(BaseModel):
    pid: str | None = None
    positions: list[ImportRow] = Field(..., max_length=_MAX_POSITIONS)


def _new_portfolio(name: str, positions: list | None = None) -> dict:
    return {"id": str(uuid.uuid4()), "name": name,
            "positions": positions or [], "realized": [], "history": []}


def _doc(username: str) -> dict:
    """Load + lazily migrate the per-user doc to the multi-portfolio shape."""
    doc = get_storage().user_doc("portfolios", username, None) or {}
    if "portfolios" not in doc:
        doc = {"portfolios": [_new_portfolio("Main", doc.get("positions") or [])]}
    for p in doc["portfolios"]:
        p.setdefault("realized", [])
        p.setdefault("history", [])
    return doc


def _save(username: str, doc: dict) -> None:
    get_storage().save_user_doc("portfolios", username, doc)


def _pick(doc: dict, pid: str | None) -> dict:
    ports = doc["portfolios"]
    if not ports:
        raise HTTPException(404, "No portfolios — create one first.")
    if pid is None:
        return ports[0]
    for p in ports:
        if p["id"] == pid:
            return p
    raise HTTPException(404, "Portfolio not found")


# ── portfolios CRUD ──────────────────────────────────────────────────────

@router.get("/list")
def list_portfolios(user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    return [{"id": p["id"], "name": p["name"],
             "positions": len(p["positions"])} for p in doc["portfolios"]]


@router.post("/create", status_code=201)
def create_portfolio(body: PortfolioCreate,
                     user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    if len(doc["portfolios"]) >= _MAX_PORTFOLIOS:
        raise HTTPException(400, f"Portfolio limit reached ({_MAX_PORTFOLIOS}).")
    p = _new_portfolio(body.name.strip())
    doc["portfolios"].append(p)
    _save(user["username"], doc)
    return {"id": p["id"], "name": p["name"], "positions": 0}


@router.delete("/{pid}", status_code=204)
def delete_portfolio(pid: str, user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    if len(doc["portfolios"]) <= 1:
        raise HTTPException(400, "Can't delete the last portfolio.")
    before = len(doc["portfolios"])
    doc["portfolios"] = [p for p in doc["portfolios"] if p["id"] != pid]
    if len(doc["portfolios"]) == before:
        raise HTTPException(404, "Portfolio not found")
    _save(user["username"], doc)


# ── positions ────────────────────────────────────────────────────────────

@router.post("/positions", status_code=201)
def add_position(body: PositionCreate, user: dict = Depends(auth.current_user)):
    from lib.resolve import canonicalize
    raw = body.ticker.strip().upper()
    doc = _doc(user["username"])
    port = _pick(doc, body.pid)
    if len(port["positions"]) >= _MAX_POSITIONS:
        raise HTTPException(400, f"Position limit reached ({_MAX_POSITIONS}).")
    pos = {"id": str(uuid.uuid4()), "ticker": canonicalize(raw) or raw,
           "qty": body.qty, "cost": body.cost}
    port["positions"].append(pos)
    _save(user["username"], doc)
    return pos


@router.delete("/positions/{pos_id}", status_code=200)
def close_position(pos_id: str, pid: str | None = None,
                   sell_price: float | None = None,
                   user: dict = Depends(auth.current_user)):
    """Remove a position. With ?sell_price=, the close is recorded as a
    realized-P&L event ((sell − cost) × qty) in the portfolio's ledger."""
    doc = _doc(user["username"])
    port = _pick(doc, pid)
    pos = next((p for p in port["positions"] if p.get("id") == pos_id), None)
    if pos is None:
        raise HTTPException(404, "Position not found")
    port["positions"] = [p for p in port["positions"] if p.get("id") != pos_id]
    realized = None
    if sell_price is not None:
        realized = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "ticker": pos["ticker"], "qty": pos["qty"],
            "cost": pos["cost"], "sell_price": sell_price,
            "pnl": (sell_price - pos["cost"]) * pos["qty"],
        }
        port["realized"].append(realized)
    _save(user["username"], doc)
    return {"ok": True, "realized": realized}


@router.post("/import", status_code=201)
def import_positions(body: ImportRequest,
                     user: dict = Depends(auth.current_user)):
    """Bulk CSV import (parsed client-side into rows). Tickers canonicalize
    the same way single adds do; per-row failures are reported, not fatal."""
    from lib.resolve import canonicalize
    doc = _doc(user["username"])
    port = _pick(doc, body.pid)
    room = _MAX_POSITIONS - len(port["positions"])
    added, skipped = 0, []
    for row in body.positions:
        if added >= room:
            skipped.append(f"{row.ticker}: position limit reached")
            continue
        raw = row.ticker.strip().upper()
        if not raw:
            continue
        port["positions"].append({
            "id": str(uuid.uuid4()), "ticker": canonicalize(raw) or raw,
            "qty": row.qty, "cost": row.cost,
        })
        added += 1
    _save(user["username"], doc)
    return {"added": added, "skipped": skipped}


# ── summary + history ────────────────────────────────────────────────────

@cached(ttl=600)
def _pos_meta(ticker: str) -> dict:
    """Sector/beta/yield for a position — quota_safe (no FMP/TD burn), cached
    10 min so summary refreshes stay cheap."""
    s = providers.snapshot(ticker, quota_safe=True) or {}
    return {"name": s.get("name") or ticker, "sector": s.get("sector"),
            "beta": s.get("beta"), "dividend_yield": s.get("dividend_yield")}


def _snapshot_history(port: dict, total_value: float, total_cost: float) -> bool:
    """Append today's value point once per (portfolio, day). Runs
    opportunistically whenever a summary is computed, so history accrues
    with normal use — no separate scheduler required."""
    today = datetime.now(timezone.utc).date().isoformat()
    hist = port["history"]
    if hist and hist[-1].get("date") == today:
        return False
    realized_cum = sum(e.get("pnl") or 0 for e in port["realized"])
    hist.append({"date": today, "value": round(total_value, 2),
                 "cost": round(total_cost, 2),
                 "unrealized": round(total_value - total_cost, 2),
                 "realized_cum": round(realized_cum, 2)})
    del hist[:-_MAX_HISTORY_DAYS]
    return True


@router.get("/summary")
def summary(pid: str | None = None, user: dict = Depends(auth.current_user)):
    """Live P&L + allocation. Quotes come from the shared cached bulk path."""
    doc = _doc(user["username"])
    port = _pick(doc, pid)
    positions = port["positions"]
    realized_total = sum(e.get("pnl") or 0 for e in port["realized"])
    base = {"portfolio": {"id": port["id"], "name": port["name"]},
            "realized": {"total": realized_total,
                         "events": list(reversed(port["realized"][-20:]))}}
    if not positions:
        return {**base, "positions": [], "totals": None, "sectors": [],
                "factors": None}

    tickers = sorted({p["ticker"] for p in positions})
    quotes = providers.quotes_bulk(tickers)

    rows, total_value, total_cost, total_day = [], 0.0, 0.0, 0.0
    for p in positions:
        q = quotes.get(p["ticker"]) or {}
        price = q.get("price")
        prev = q.get("prev_close")
        meta = _pos_meta(p["ticker"])
        value = price * p["qty"] if price is not None else None
        cost_total = p["cost"] * p["qty"]
        pnl = (value - cost_total) if value is not None else None
        day = ((price - prev) * p["qty"]) if (price is not None and prev is not None) else None
        rows.append({
            **p, "name": meta["name"], "sector": meta["sector"],
            "beta": meta["beta"], "dividend_yield": meta["dividend_yield"],
            "price": price, "value": value, "pnl": pnl,
            "pnl_pct": (pnl / cost_total * 100) if (pnl is not None and cost_total) else None,
            "day_pnl": day, "currency": q.get("currency"),
        })
        if value is not None:
            total_value += value
            total_cost += cost_total
        if day is not None:
            total_day += day

    for r in rows:
        r["weight"] = (r["value"] / total_value * 100) if (r["value"] and total_value) else None

    # Sector allocation + weighted factor exposure over priced positions.
    sectors: dict[str, float] = {}
    wbeta = wyield = wsum = 0.0
    for r in rows:
        if not r["value"]:
            continue
        sectors[r["sector"] or "Unknown"] = sectors.get(r["sector"] or "Unknown", 0) + r["value"]
        if r["beta"] is not None:
            wbeta += r["beta"] * r["value"]
        if r["dividend_yield"] is not None:
            wyield += r["dividend_yield"] * r["value"]
        wsum += r["value"]

    if total_value > 0 and _snapshot_history(port, total_value, total_cost):
        _save(user["username"], doc)

    return {
        **base,
        "positions": rows,
        "totals": {
            "value": total_value, "cost": total_cost,
            "pnl": total_value - total_cost,
            "pnl_pct": ((total_value - total_cost) / total_cost * 100) if total_cost else None,
            "day_pnl": total_day,
        },
        "sectors": sorted(
            [{"sector": s, "value": v, "weight": v / total_value * 100}
             for s, v in sectors.items()],
            key=lambda x: -x["value"]),
        "factors": {
            "beta": (wbeta / wsum) if wsum else None,
            "dividend_yield": (wyield / wsum) if wsum else None,
            "top_weight": max((r["weight"] or 0) for r in rows) if rows else None,
        },
    }


@router.get("/history")
def history(pid: str | None = None, user: dict = Depends(auth.current_user)):
    """Daily value/cost/realized series (accrues one point per day the
    summary is viewed; up to 2 years retained)."""
    doc = _doc(user["username"])
    port = _pick(doc, pid)
    return {"portfolio": {"id": port["id"], "name": port["name"]},
            "points": port["history"]}


# Legacy route kept for old clients: full first-portfolio doc.
@router.get("")
def get_portfolio(user: dict = Depends(auth.current_user)):
    doc = _doc(user["username"])
    return {"positions": doc["portfolios"][0]["positions"] if doc["portfolios"] else []}
