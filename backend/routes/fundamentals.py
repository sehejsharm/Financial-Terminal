"""Financial statements, estimates, capital structure, comps, ownership, ratings.

Every route here is wrapped in defensive try/except + always-200 empty
fallbacks. Free data providers (yfinance) blank-out on cloud IPs where
Yahoo bot-detects us, and we'd rather show "unavailable" copy than a red
"Failed to load" toast over a 500.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

import pandas as pd

from backend import auth, providers
from backend.cache import cached
from backend.serialize import clean, clean_dict, frame_payload, records
from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
    capital_structure,
    get_estimates,
    get_statement,
    select_rows,
)
from lib import nse, nse_financials
from lib.institutional import (
    comps_matrix,
    get_earnings_history,
    get_officers,
    get_ownership,
    get_ratings,
)

router = APIRouter(prefix="/fundamentals", tags=["fundamentals"])

_KINDS = {"income": INCOME_ROWS, "balance": BALANCE_ROWS, "cashflow": CASHFLOW_ROWS}


_UNAVAIL_NOTE = ("Financial statements are unavailable for this ticker from "
                 "the configured providers (FMP, then the company's own XBRL "
                 "results filing on NSE for Indian listings, then yfinance). "
                 "FMP's free tier covers US listings; if FMP_API_KEY isn't "
                 "set, US coverage is limited to what yfinance allows from "
                 "this host.")

# The XBRL a company files with its quarterly results is an income statement.
# Asking it for a balance sheet or a cash flow gets a truthful "this source
# doesn't carry that" rather than an empty frame that reads as a company with
# no assets.
_NSE_KIND_NOTE = ("These figures come from the XBRL document a company files "
                  "with its quarterly results on NSE, which carries the "
                  "income statement only — there is no balance sheet or cash "
                  "flow in it, and no free API exposes those for Indian "
                  "listings. The income statement above IS available.")


def _df_colmajor(df: pd.DataFrame) -> dict:
    """yfinance estimate frame -> column-major {col: {row: value}} (JSON-safe)."""
    out: dict = {}
    for col in df.columns:
        out[str(col)] = {str(idx): clean(val) for idx, val in df[col].items()}
    return out


@router.get("/{ticker}/statement/{kind}")
@cached(ttl=21600)
def statement(ticker: str, kind: str, quarterly: bool = False,
              _user: dict = Depends(auth.current_user)):
    """Statements: FMP first (deterministic REST API, works on cloud IPs),
    yfinance scrape as fallback. Response carries `source` so the UI can say
    where the numbers came from, and `note` explains any empty result."""
    if kind not in _KINDS:
        raise HTTPException(400, "kind must be one of income|balance|cashflow")
    empty = {"ticker": ticker, "kind": kind, "rows": [], "columns": [],
             "source": None, "note": _UNAVAIL_NOTE}

    if providers.has_fmp():
        fmp = providers.fmp_statement(ticker, kind, quarterly=quarterly)
        if fmp and fmp.get("rows"):
            return {"ticker": ticker, "kind": kind, "quarterly": quarterly,
                    "columns": fmp["columns"], "rows": fmp["rows"],
                    "source": "FMP"}

    # The company's own XBRL results filing on NSE: the only free source of
    # statements for Indian listings, and the reason FA was empty for the
    # market this app is built around. Income statement only — the results
    # filing carries nothing else.
    if nse.is_indian(ticker):
        try:
            parsed = nse_financials.financial_results(ticker, quarterly=True)
        except Exception:
            parsed = {"columns": [], "rows": []}
        if kind == "income" and parsed.get("rows"):
            # Annual view: the feed is quarterly, so a yearly column would have
            # to be summed, and summing a partial year silently understates it.
            # Quarterly is what the source actually has, so that is what is
            # returned, labelled honestly.
            return {"ticker": ticker, "kind": kind, "quarterly": True,
                    "columns": parsed["columns"], "rows": parsed["rows"],
                    "source": "NSE filings",
                    "note": None if quarterly else
                            ("NSE publishes quarterly filings, so these are "
                             "quarters even though the annual view was "
                             "requested — summing them into years would hide a "
                             "partial year as a full one.")}
        if kind in ("balance", "cashflow") and parsed.get("rows"):
            return {**empty, "note": _NSE_KIND_NOTE}

    try:
        df = select_rows(get_statement(ticker, kind, quarterly), _KINDS[kind])
    except Exception:
        df = None
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
            "source": "yfinance",
        }
    except Exception:
        return empty


@router.get("/{ticker}/estimates")
@cached(ttl=3600)
def estimates(ticker: str, _user: dict = Depends(auth.current_user)):
    try:
        raw = get_estimates(ticker) or {}
    except Exception:
        raw = {}
    out: dict = {}
    pt = raw.get("price_targets")
    if isinstance(pt, dict) and pt:
        out["price_targets"] = clean_dict(pt)
    for key in ("earnings_estimate", "revenue_estimate", "growth_estimates"):
        df = raw.get(key)
        if isinstance(df, pd.DataFrame) and not df.empty:
            out[key] = _df_colmajor(df)
    # FMP fallback for price targets when yfinance gives none.
    if not out.get("price_targets") and providers.has_fmp():
        pt2 = providers.fmp_price_target(ticker)
        if pt2:
            out["price_targets"] = clean_dict(pt2)
    return out


@router.get("/{ticker}/capital-structure")
@cached(ttl=3600)
def cap_structure(ticker: str, _user: dict = Depends(auth.current_user)):
    empty = {"total_debt": None, "cash": None, "market_cap": None,
             "shares": None, "currency": "USD"}
    try:
        cs = capital_structure(ticker)
    except Exception:
        cs = None
    # yfinance blocked / missing -> FMP fallback (reliable on cloud, US coverage)
    if (not cs or cs.get("total_debt") is None) and providers.has_fmp():
        fc = providers.fmp_capital(ticker)
        if fc:
            return fc
    return cs or empty


@router.get("/{ticker}/peers")
@cached(ttl=3600)
def peers(ticker: str, _user: dict = Depends(auth.current_user)):
    """Comparable-company suggestions by sector + exchange (curated map —
    no free API offers real comparables selection). Never mixes exchanges."""
    from lib.peers import get_peers
    try:
        snap = providers.snapshot(ticker, quota_safe=True) or {}
    except Exception:
        snap = {}
    return get_peers(ticker, snap.get("sector") or snap.get("industry"))


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
