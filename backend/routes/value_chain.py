"""Value-chain mapper — returns structured JSON (suppliers/customers/competitors)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from backend import auth
from lib import ai_analyst, value_chain as vc
from lib.market_data import get_stock_fundamentals

router = APIRouter(prefix="/value-chain", tags=["value-chain"])


@router.get("/{ticker}")
def chain(ticker: str, _user: dict = Depends(auth.current_user)):
    if not ai_analyst.is_available():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "No AI provider configured (GROQ_API_KEY or "
                            "GEMINI_API_KEY)")
    f = get_stock_fundamentals(ticker)
    company_name = (f or {}).get("name") or ticker
    try:
        data = vc.get_chain_data(ticker, company_name)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    if not data:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            "Could not parse a structured response.")
    return {"ticker": ticker, "name": company_name, **data}
