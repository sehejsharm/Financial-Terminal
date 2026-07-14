"""Big Sharks: NSE bulk + block deals (end-of-day) + flow aggregation."""
from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from backend.serialize import records
from lib import nse
from lib.deals import get_block_deals, get_bulk_deals

router = APIRouter(prefix="/deals", tags=["deals"])


@router.get("/bulk")
@cached(ttl=900)
def bulk(_user: dict = Depends(auth.current_user)):
    return records(get_bulk_deals())


@router.get("/block")
@cached(ttl=900)
def block(_user: dict = Depends(auth.current_user)):
    return records(get_block_deals())


def _col(df: pd.DataFrame, *needles: str) -> str | None:
    for c in df.columns:
        lc = str(c).lower()
        if all(n in lc for n in needles):
            return c
    return None


@router.get("/aggregate")
@cached(ttl=900)
def aggregate(kind: str = "bulk", days: int = 30,
              _user: dict = Depends(auth.current_user)):
    """Per-stock flow intelligence: net buy/sell by bulk/block participants
    over the trailing window (bounded by what NSE's archive CSV covers —
    the covered date range is reported in the response)."""
    if kind not in ("bulk", "block"):
        raise HTTPException(400, "kind must be bulk|block")
    days = max(1, min(days, 365))
    df = get_bulk_deals() if kind == "bulk" else get_block_deals()
    empty = {"rows": [], "from": None, "to": None,
             "note": "NSE archive unavailable right now."}
    if df is None or df.empty:
        return empty

    sym_c = _col(df, "symbol")
    side_c = _col(df, "buy") or _col(df, "sell")
    qty_c = _col(df, "quantity")
    price_c = _col(df, "price")
    date_c = _col(df, "date")
    client_c = _col(df, "client")
    if not (sym_c and side_c and qty_c and date_c):
        return empty

    d = df.copy()
    d["_date"] = pd.to_datetime(d[date_c], format="%d-%b-%Y", errors="coerce")
    d = d.dropna(subset=["_date"])
    if d.empty:
        return empty
    cutoff = d["_date"].max() - pd.Timedelta(days=days)
    d = d[d["_date"] >= cutoff]

    d["_qty"] = pd.to_numeric(d[qty_c], errors="coerce").fillna(0)
    d["_px"] = pd.to_numeric(d[price_c], errors="coerce") if price_c else None
    d["_buy"] = d[side_c].astype(str).str.strip().str.upper().str.startswith("B")
    d["_val"] = d["_qty"] * (d["_px"] if price_c else 0)

    out = []
    for sym, g in d.groupby(sym_c):
        buys = g[g["_buy"]]
        sells = g[~g["_buy"]]
        buy_val = float(buys["_val"].sum()) if price_c else None
        sell_val = float(sells["_val"].sum()) if price_c else None
        out.append({
            "symbol": str(sym),
            "deals": int(len(g)),
            "participants": int(g[client_c].nunique()) if client_c else None,
            "buy_qty": float(buys["_qty"].sum()),
            "sell_qty": float(sells["_qty"].sum()),
            "net_qty": float(buys["_qty"].sum() - sells["_qty"].sum()),
            "buy_value": buy_val,
            "sell_value": sell_val,
            "net_value": (buy_val - sell_val) if price_c else None,
        })
    out.sort(key=lambda r: -abs(r["net_value"] if r["net_value"] is not None
                                else r["net_qty"]))
    return {
        "rows": out[:100],
        "from": d["_date"].min().date().isoformat(),
        "to": d["_date"].max().date().isoformat(),
        "note": (f"Aggregated from NSE's EOD {kind}-deal archive over the "
                 f"covered window — not a real-time flow feed."),
    }


@router.get("/insider")
@cached(ttl=1800)
def insider(_user: dict = Depends(auth.current_user)):
    """Insider (SAST/PIT) disclosures from NSE corporates API — best-effort;
    returns an empty list + note when NSE blocks the endpoint."""
    rows = nse.insider_transactions()
    if rows is None:
        return {"rows": [], "note": "NSE insider-disclosure feed unavailable "
                                    "from this host right now."}
    return {"rows": rows, "note": None}
