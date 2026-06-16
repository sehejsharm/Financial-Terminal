"""Options: expiries, chains, Greeks, max pain."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth
from backend.cache import cached
from lib import options as opt
from lib.market_data import get_quote

router = APIRouter(prefix="/options", tags=["options"])


@router.get("/{ticker}/expiries")
@cached(ttl=300)
def expiries(ticker: str, _user: dict = Depends(auth.current_user)):
    return opt.get_expiries(ticker)


@router.get("/{ticker}/chain")
@cached(ttl=60)
def chain(ticker: str, expiry: str, risk_free: float = 0.05,
          _user: dict = Depends(auth.current_user)):
    q = get_quote(ticker)
    S = q.get("price") if q else None
    if S is None:
        raise HTTPException(404, f"No underlying price for '{ticker}'")
    T = opt.years_to_expiry(expiry)
    raw = opt.get_option_chain(ticker, expiry)
    calls = opt.enrich_with_greeks(raw["calls"], S, T, risk_free, "call")
    puts = opt.enrich_with_greeks(raw["puts"], S, T, risk_free, "put")
    mp = opt.max_pain(raw["calls"], raw["puts"])
    return {
        "ticker": ticker, "expiry": expiry, "spot": float(S),
        "years_to_expiry": T,
        "calls": [] if calls is None or calls.empty else calls.to_dict("records"),
        "puts": [] if puts is None or puts.empty else puts.to_dict("records"),
        "max_pain": mp,
    }
