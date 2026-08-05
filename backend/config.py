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


# ── passkeys ─────────────────────────────────────────────────────────────
#
# A passkey is bound to ONE relying-party id, and that binding is what makes
# it safe: a credential minted for this domain cannot be replayed at another.
# The same property is the operational catch — move the app to a new domain
# and every existing passkey stops working, because the browser will not even
# offer it.
#
# That is survivable here only because passkeys SUPPLEMENT the password: a
# user whose passkey stopped matching still signs in the way they always did
# and can enrol a new one. It is the reason this shipped before the permanent
# domain was chosen.
#
# The default derives the id from the first configured CORS origin, so a local
# dev setup and a single-domain deployment both work with no configuration.
# Set WEBAUTHN_RP_ID explicitly before going to production, and prefer the
# registrable domain (example.com) over a subdomain (app.example.com) if
# subdomains might ever serve the app — widening it later invalidates every
# credential, narrowing it does not.
def _default_rp_id() -> str:
    from urllib.parse import urlparse
    for origin in CORS_ORIGINS:
        host = urlparse(origin).hostname
        if host:
            return host
    return "localhost"


WEBAUTHN_RP_ID = (os.getenv("WEBAUTHN_RP_ID") or "").strip() or _default_rp_id()
WEBAUTHN_RP_NAME = (os.getenv("WEBAUTHN_RP_NAME") or "").strip() or "Motherboard Terminal"

# Origins a ceremony may come from. Matched exactly, never by suffix, so each
# preview deployment that needs passkeys has to be listed.
WEBAUTHN_ORIGINS = [
    o.strip() for o in (os.getenv("WEBAUTHN_ORIGINS") or "").split(",") if o.strip()
] or CORS_ORIGINS
