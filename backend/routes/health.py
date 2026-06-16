"""Health + version (unauthenticated)."""
from __future__ import annotations

import os
from datetime import datetime, timezone

from fastapi import APIRouter

from backend.cache import cache_info

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz():
    return {"ok": True,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}


@router.get("/version")
def version():
    return {
        "service": "motherboard-api",
        "version": os.getenv("APP_VERSION", "0.1.0"),
        "cache": cache_info(),
    }


@router.get("/diag")
def diag():
    """Live data-provider diagnostics. Hit this to see which providers are
    actually reachable from this host — answers "why is X empty?" in one call.
    Unauthenticated by design so it works from a browser during ops triage.
    """
    out: dict = {
        "providers": {
            "nse": {"configured": True, "ok": False, "sample": None},
            "twelve_data": {"configured": bool(os.getenv("TWELVE_DATA_API_KEY")),
                            "ok": False, "sample": None},
            "yfinance": {"configured": True, "ok": False, "sample": None},
            "fred": {"configured": bool(os.getenv("FRED_API_KEY"))},
            "groq": {"configured": bool(os.getenv("GROQ_API_KEY"))},
            "gemini": {"configured": bool(os.getenv("GEMINI_API_KEY"))},
        },
        "cache": cache_info(),
    }
    try:
        from lib import nse
        q = nse.index_quote("^NSEI")
        out["providers"]["nse"]["ok"] = bool(q and q.get("price"))
        out["providers"]["nse"]["sample"] = q
    except Exception as e:
        out["providers"]["nse"]["error"] = str(e)[:200]
    try:
        from backend import providers as p
        if p.has_twelvedata():
            q = p._td_quote("AAPL")
            out["providers"]["twelve_data"]["ok"] = bool(q and q.get("price"))
            out["providers"]["twelve_data"]["sample"] = q
    except Exception as e:
        out["providers"]["twelve_data"]["error"] = str(e)[:200]
    try:
        from lib import market_data as md
        q = md.get_quote("AAPL")
        out["providers"]["yfinance"]["ok"] = bool(q and q.get("price"))
        out["providers"]["yfinance"]["sample"] = q
    except Exception as e:
        out["providers"]["yfinance"]["error"] = str(e)[:200]
    return out
