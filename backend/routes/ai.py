"""AI endpoints — bull/bear, deep analysis."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from backend import auth
from backend.schemas import AIRequest
from lib import ai_analyst
from lib.market_data import get_stock_fundamentals

router = APIRouter(prefix="/ai", tags=["ai"])


def _guard():
    if not ai_analyst.is_available():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "No AI provider configured (GROQ_API_KEY or "
                            "GEMINI_API_KEY)")


@router.get("/provider")
def provider(_user: dict = Depends(auth.current_user)):
    return {"available": ai_analyst.is_available(),
            "provider": ai_analyst.active_provider()}


@router.post("/bull-bear")
def bull_bear(body: AIRequest, _user: dict = Depends(auth.current_user)):
    _guard()
    f = get_stock_fundamentals(body.ticker) or {}
    try:
        text = ai_analyst.bull_bear_case(body.ticker, f, None)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"ticker": body.ticker, "markdown": text}


@router.post("/deep-analysis")
def deep(body: AIRequest, _user: dict = Depends(auth.current_user)):
    _guard()
    f = get_stock_fundamentals(body.ticker) or {}
    try:
        text = ai_analyst.deep_analysis(body.ticker, f, None)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"ticker": body.ticker, "markdown": text}
