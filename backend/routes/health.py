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
