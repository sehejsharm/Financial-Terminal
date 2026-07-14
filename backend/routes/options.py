"""Options: expiries, chains, Greeks, max pain."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from backend.serialize import records
from lib import options as opt
from lib.market_data import get_quote

log = logging.getLogger("motherboard.options")

router = APIRouter(prefix="/options", tags=["options"])


@router.get("/{ticker}/expiries")
@cached(ttl=300)
def expiries(ticker: str, _user: dict = Depends(auth.current_user)):
    return opt.get_expiries(ticker)


_CHAIN_NOTE = ("Option chains are unavailable here on free data — yfinance's "
               "option endpoint is IP-blocked on cloud hosts, and NSE F&O isn't "
               "wired in yet. View options in the Streamlit app for now.")


@router.get("/{ticker}/chain")
@cached(ttl=60)
def chain(ticker: str, expiry: str, risk_free: float = 0.05,
          _user: dict = Depends(auth.current_user)):
    q = get_quote(ticker)
    S = q.get("price") if q else None
    empty = {"ticker": ticker, "expiry": expiry, "spot": float(S) if S else None,
             "years_to_expiry": opt.years_to_expiry(expiry),
             "calls": [], "puts": [], "max_pain": None, "note": _CHAIN_NOTE}
    if S is None:
        return empty
    try:
        T = opt.years_to_expiry(expiry)
        raw = opt.get_option_chain(ticker, expiry)
        calls = opt.enrich_with_greeks(raw["calls"], S, T, risk_free, "call")
        puts = opt.enrich_with_greeks(raw["puts"], S, T, risk_free, "put")
        mp = opt.max_pain(raw["calls"], raw["puts"])
        # records() coerces NaN/Timestamp/numpy scalars to JSON-safe values.
        # Raw .to_dict("records") shipped NaN floats straight into FastAPI's
        # encoder, which raised and turned every real chain into a 500
        # ("Failed to load chain") the moment yfinance actually worked.
        call_rows = records(calls)
        put_rows = records(puts)
        if not call_rows and not put_rows:
            return empty
        return {
            "ticker": ticker, "expiry": expiry, "spot": float(S),
            "years_to_expiry": T,
            "calls": call_rows, "puts": put_rows,
            "max_pain": None if mp is None else float(mp),
        }
    except Exception:
        # Surface the real failure in logs instead of swallowing it silently.
        log.exception("option chain failed for %s %s", ticker, expiry)
        return empty
