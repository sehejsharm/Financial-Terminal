"""JWT auth wrapper around the existing PBKDF2 user store (lib.auth).

This deliberately reuses lib.auth so a single user can log in either to the
Streamlit UI or to the API. When the Postgres migration happens (see
docs/enterprise-migration-plan.md Phase 1/4), this is the only file that
changes — endpoint code stays put.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.config import JWT_ALGO, JWT_TTL_MINUTES, get_jwt_secret
from lib import auth as user_store

_bearer = HTTPBearer(auto_error=False)


def issue_token(user: dict) -> dict:
    """Return {access_token, expires_at_iso, role}."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=JWT_TTL_MINUTES)
    payload = {
        "sub": user["username"],
        "role": user.get("role", "user"),
        # The plan rides in the token so an entitlement check is free rather
        # than a user-table read on every request. It can therefore be up to
        # one access-token lifetime stale (15 minutes), which is fine for a
        # DOWNGRADE and not fine for an upgrade — so the client forces a
        # refresh after a plan change, and /billing/plan always reads live.
        "plan": user.get("plan") or "",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGO)
    return {"access_token": token, "expires_at": exp.isoformat(),
            "role": user.get("role", "user")}


def authenticate(username: str, password: str) -> dict | None:
    """Verify credentials via the shared user store."""
    return user_store.verify_credentials(username, password)


def user_for_session(username: str) -> dict | None:
    """The user a refresh is being performed for, or None if they may no
    longer sign in.

    Separate from `authenticate` because a refresh proves possession of a
    session, not knowledge of the password — but it must still honour
    `active`, so that deactivating an account takes effect at the next refresh
    instead of thirty days later.
    """
    return user_store.get_user(username)


def current_user(credentials: HTTPAuthorizationCredentials | None
                 = Depends(_bearer)) -> dict:
    """FastAPI dependency: decode the bearer token, return claims."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Missing bearer token")
    try:
        claims = jwt.decode(credentials.credentials, get_jwt_secret(),
                            algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    return {"username": claims["sub"], "role": claims.get("role", "user"),
            "plan": claims.get("plan") or ""}


def decode_token(token: str | None) -> dict | None:
    """Validate a raw JWT (e.g. from a WebSocket/SSE ?token= query param,
    where an Authorization header can't be set). Returns claims or None."""
    if not token:
        return None
    try:
        claims = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGO])
    except jwt.InvalidTokenError:
        return None
    return {"username": claims["sub"], "role": claims.get("role", "user"),
            "plan": claims.get("plan") or ""}


def require_master_admin(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != user_store.ROLE_MASTER:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Master-admin role required")
    return user
