"""Backend configuration — env-driven, no defaults that leak in prod."""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
# MB_DATA_DIR override exists for test harnesses (e2e runs point it at a
# scratch dir); default is unchanged.
DATA_DIR = Path(os.getenv("MB_DATA_DIR") or (BASE_DIR / "data"))

# JWT
JWT_ALGO = "HS256"
JWT_TTL_MINUTES = int(os.getenv("BACKEND_JWT_TTL_MIN", "720"))  # 12 h


def get_jwt_secret() -> str:
    """Persistent JWT secret — env > data/.jwt_secret (auto-generated once).

    Auto-generation is convenience for local dev. In production, *set the env
    var* so tokens survive container restarts.
    """
    key = (os.getenv("BACKEND_JWT_SECRET") or "").strip()
    if key:
        return key
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / ".jwt_secret"
    if path.exists():
        return path.read_text().strip()
    secret = secrets.token_urlsafe(48)
    path.write_text(secret)
    return secret


# Redis (optional). If unset, the cache falls back to an in-process LRU.
REDIS_URL: str | None = (os.getenv("REDIS_URL") or "").strip() or None

# CORS — comma-separated list. Defaults safe for local dev only.
CORS_ORIGINS = [
    o.strip() for o in
    (os.getenv("BACKEND_CORS_ORIGINS") or "http://localhost:3000,http://localhost:8501").split(",")
    if o.strip()
]
