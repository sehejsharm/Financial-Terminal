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

# Deployment environment. Only "production" is special, and only to turn
# configuration that is merely convenient in development into a hard failure.
APP_ENV = (os.getenv("MOTHERBOARD_ENV") or "development").strip().lower()
IS_PRODUCTION = APP_ENV == "production"

# JWT — the ACCESS token only.
#
# This was 720 minutes (12 h), which was the whole problem: a JWT cannot be
# withdrawn, so a stolen token, a deactivated account or a password change had
# no effect for up to twelve hours. The long-lived half of the credential now
# lives in backend/sessions.py as a revocable server-side record, and this
# token shrinks to minutes — which is what makes revocation mean anything,
# since the worst case becomes one access-token lifetime.
#
# BACKEND_JWT_TTL_MIN is still honoured so an operator can widen it, but the
# default no longer assumes the token is the session.
JWT_ALGO = "HS256"
JWT_TTL_MINUTES = int(os.getenv("BACKEND_JWT_TTL_MIN", "15"))

# ── session cookie ────────────────────────────────────────────────────────
# Carries the refresh token, and nothing else ever.
#
# HttpOnly: the point of the exercise. The access token used to sit in a
# JS-readable cookie, so any XSS — including one arriving through a
# compromised dependency — could read a 12-hour session credential. Script can
# no longer see this one at all.
#
# SameSite=Strict rather than Lax: this cookie is only ever needed on a fetch
# the app itself makes to /auth/refresh, never on a top-level navigation from
# somewhere else, so Strict costs nothing here and removes cross-site
# submission as a category. (Lax would already block the dangerous cases, but
# "costs nothing" is a better reason than "probably fine".)
#
# Path: scoped to the auth routes, so the browser does not attach a session
# credential to the hundreds of market-data requests that have no use for it.
REFRESH_COOKIE = "mb_refresh"
REFRESH_COOKIE_PATH = "/api/v1/auth"
# Secure is mandatory in production and off in development, because
# http://localhost would otherwise never receive the cookie — and a developer
# debugging that tends to "fix" it by removing the flag everywhere.
COOKIE_SECURE = IS_PRODUCTION or (os.getenv("COOKIE_SECURE") == "1")
# A CSRF cookie readable by script, paired with a header the app echoes back.
# See backend/csrf.py for why a readable cookie is the right shape here.
CSRF_COOKIE = "mb_csrf"
CSRF_HEADER = "X-CSRF-Token"


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


def _resolve_rp_id() -> str:
    """The relying-party id, refusing to boot on a value that would silently
    break passkeys in production.

    The RP ID is bound into every credential at enrolment. If it changes,
    every enrolled passkey stops matching — and the failure is silent, because
    the browser simply reports no credential available, which looks like the
    user's device misbehaving rather than a server misconfiguration.

    Two ways that happened by accident, both now refused rather than derived:

      * Neither WEBAUTHN_RP_ID nor BACKEND_CORS_ORIGINS set in production, so
        the id derived to "localhost" and no passkey could ever work.
      * BACKEND_CORS_ORIGINS reordered, which silently moved the id to a
        different host and invalidated every existing credential.

    Deriving is still fine for local development, where the cost of getting it
    wrong is one developer re-enrolling. MOTHERBOARD_ENV=production turns the
    derivation into a hard failure, which is the right moment to find out.
    """
    explicit = (os.getenv("WEBAUTHN_RP_ID") or "").strip()
    if explicit:
        return explicit
    derived = _default_rp_id()
    if APP_ENV == "production":
        raise RuntimeError(
            "WEBAUTHN_RP_ID must be set explicitly in production (would have "
            f"derived {derived!r} from BACKEND_CORS_ORIGINS). It is baked into "
            "every enrolled passkey: deriving it means a reordered CORS list "
            "silently invalidates all of them. Prefer the registrable domain "
            "(example.com) over a subdomain if subdomains might ever serve the "
            "app — widening it later invalidates every credential, narrowing "
            "it does not."
        )
    return derived


WEBAUTHN_RP_ID = _resolve_rp_id()
WEBAUTHN_RP_NAME = (os.getenv("WEBAUTHN_RP_NAME") or "").strip() or "Motherboard Terminal"

# Origins a ceremony may come from. Matched exactly, never by suffix, so each
# preview deployment that needs passkeys has to be listed.
WEBAUTHN_ORIGINS = [
    o.strip() for o in (os.getenv("WEBAUTHN_ORIGINS") or "").split(",") if o.strip()
] or CORS_ORIGINS
