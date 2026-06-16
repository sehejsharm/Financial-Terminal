"""Financial statements, estimates, capital structure, comps, ownership, ratings.

Every route here is wrapped in defensive try/except + always-200 empty
fallbacks. Free data providers (yfinance) blank-out on cloud IPs where
Yahoo bot-detects us, and we'd rather show "unavailable" copy than a red
"Failed to load" toast over a 500.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend import auth
from backend.cache import cached
from backend.serialize import clean_dict, frame_payload, records
from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
    capital_structure,
    get_estimates,
    get_statement,
    select_rows,
)
from lib import nse
from lib.institutional import (
    comps_matrix,
    get_earnings_history,
    get_officers,
    get_ownership,
    get_ratings,
)

router = APIRouter(prefix="/fundamentals", tags=["fundamentals"])

_KINDS = {"income": INCOME_ROWS, "balance": BALANCE_ROWS, "cashflow": CASHFLOW_ROWS}


_UNAVAIL_NOTE = ("Free providers (yfinance) blank this field for many "
                 "tickers on cloud hosts. Set TWELVE_DATA_API_KEY or use "
                 "the Streamlit app for fuller coverage.")


@router.get("/{ticker}/statement/{kind}")
@cached(ttl=3600)
def statement(ticker: str, kind: str, quarterly: bool = False,
              _user: dict = Depends(auth.current_user)):
    if kind not in _KINDS:
        raise HTTPException(400, "kind must be one of income|balance|cashflow")
    empty = {"ticker": ticker, "kind": kind, "rows": [], "columns": [],
             "note": _UNAVAIL_NOTE}
    try:
        df = select_rows(get_statement(ticker, kind, quarterly), _KINDS[kind])
    except Exception:
        return empty
    if df is None or getattr(df, "empty", True):
        return empty
    try:
        rows = [{"line": str(idx),
                 **{str(c): (None if v is None else
                             (float(v) if hasattr(v, "__float__") else str(v)))
                    for c, v in row.items()}}
                for idx, row in df.iterrows()]
        return {
            "ticker": ticker, "kind": kind, "quarterly": quarterly,
            "columns": [str(c) for c in df.columns],
            "rows": rows,
        }
    except Exception:
        return empty


@router.get("/{ticker}/estimates")
@cached(ttl=3600)
def estimates(ticker: str, _user: dict = Depends(auth.current_user)):
    try:
        return get_estimates(ticker) or {}
    except Exception:
        return {}


@router.get("/{ticker}/capital-structure")
@cached(ttl=3600)
def cap_structure(ticker: str, _user: dict = Depends(auth.current_user)):
    try:
        return capital_structure(ticker) or {
            "total_debt": None, "cash": None, "market_cap": None,
            "shares": None, "currency": "USD",
        }
    except Exception:
        return {"total_debt": None, "cash": None, "market_cap": None,
                "shares": None, "currency": "USD"}


@router.get("/comps")
@cached(ttl=900)
def comps(tickers: str = Query(..., description="Comma-separated peer tickers"),
          _user: dict = Depends(auth.current_user)):
    ts = [t.strip().upper() for t in tickers.split(",") if t.strip()][:10]
    if not ts:
        raise HTTPException(400, "No tickers provided")
    try:
        return records(comps_matrix(ts))
    except Exception:
        return []


def _nse_shareholding_as_major_holders(rows):
    """Convert NSE's shareholding-pattern rows into the major_holders frame
    shape the frontend already renders. Columns vary by ticker; we surface
    whatever NSE returns."""
    if not rows:
        return {"columns": [], "rows": []}
    cols = list(rows[0].keys())
    return {"columns": cols, "rows": rows}


@router.get("/{ticker}/ownership")
@cached(ttl=3600)
def ownership(ticker: str, _user: dict = Depends(auth.current_user)):
    empty_frame = {"columns": [], "rows": []}
    try:
        # yfinance path (US-centric coverage)
        own = get_ownership(ticker) or {}
        major = frame_payload(own.get("major_holders"))
        inst = frame_payload(own.get("institutional_holders"))
        mfs = frame_payload(own.get("mutualfund_holders"))
        officers = [
            {"name": o.get("name"), "title": o.get("title"),
             "pay": o.get("pay"), "age": o.get("age")}
            for o in (get_officers(ticker) or [])
        ]

        # NSE overlay: shareholding pattern (promoter/public/FII/DII) for .NS
        if nse.is_indian(ticker) and not major["rows"]:
            corp = nse.corporate_info(ticker) or {}
            sp = corp.get("shareholding_pattern") or []
            if sp:
                major = _nse_shareholding_as_major_holders(sp)

        return {
            "major_holders": major,
            "institutional_holders": inst,
            "mutualfund_holders": mfs,
            "officers": officers,
        }
    except Exception:
        return {"major_holders": empty_frame, "institutional_holders": empty_frame,
                "mutualfund_holders": empty_frame, "officers": []}


@router.get("/{ticker}/earnings-history")
@cached(ttl=3600)
def earnings_history(ticker: str, _user: dict = Depends(auth.current_user)):
    try:
        return frame_payload(get_earnings_history(ticker))
    except Exception:
        return {"columns": [], "rows": []}


@router.get("/{ticker}/ratings")
@cached(ttl=3600)
def ratings(ticker: str, _user: dict = Depends(auth.current_user)):
    try:
        r = get_ratings(ticker) or {}
        return {
            "targets": clean_dict(r.get("targets") if isinstance(r.get("targets"), dict) else {}),
            "recommendations": frame_payload(r.get("recommendations")),
        }
    except Exception:
        return {"targets": {}, "recommendations": {"columns": [], "rows": []}}
