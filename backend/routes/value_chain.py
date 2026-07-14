"""Value-chain mapper — returns structured JSON (suppliers/customers/competitors)."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend import auth
from lib import ai_analyst, value_chain as vc
from lib.auth import DATA_DIR
from lib.market_data import get_stock_fundamentals

router = APIRouter(prefix="/value-chain", tags=["value-chain"])

REPORTS_PATH = DATA_DIR / "vc_reports.jsonl"


class ChainReport(BaseModel):
    """User flag: a generated relationship looks wrong. Feeds a review queue
    (Admin page) instead of silently trusting the LLM forever."""
    node_name: str = Field(..., max_length=120)
    role: str = Field(..., max_length=20)          # supplier|customer|competitor
    reason: str = Field("", max_length=500)


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


@router.post("/{ticker}/report")
def report(ticker: str, body: ChainReport,
           user: dict = Depends(auth.current_user)):
    """Append a wrong-relationship flag to the review queue (JSONL on the
    persistent data volume; listed on the Admin page)."""
    rec = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "user": (user or {}).get("username"),
        "ticker": ticker.upper(),
        "node_name": body.node_name,
        "role": body.role,
        "reason": body.reason,
    }
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(REPORTS_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        raise HTTPException(500, "Could not record the report.")
    return {"ok": True}


@router.get("/reports/all")
def list_reports(limit: int = 200,
                 _user: dict = Depends(auth.require_master_admin)):
    """Review queue for the Admin page — most recent first."""
    if not REPORTS_PATH.exists():
        return []
    try:
        with open(REPORTS_PATH, "r", encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
        out = []
        for ln in lines:
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
        return list(reversed(out))
    except Exception:
        return []
