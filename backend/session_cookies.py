"""Setting and clearing the session cookies, in one place.

Shared by the password login and the passkey login. It lives in its own module
rather than in one of the routers because both need it, and a router importing
another router to borrow a helper is how import cycles start.

The attributes here are the security properties, so they are set once and not
restated per call site — a `samesite="lax"` that drifted into one of two login
paths would be invisible in review and would quietly weaken only the path
nobody tested.
"""
from __future__ import annotations

from fastapi import Request, Response

from backend import csrf, ratelimit, sessions
from backend.config import (COOKIE_SECURE, CSRF_COOKIE, CSRF_COOKIE_PATH,
                            REFRESH_COOKIE, REFRESH_COOKIE_PATH)


def set_session(response: Response, refresh_token: str) -> str:
    """Attach the refresh cookie plus its matching CSRF cookie.

    Returns the CSRF token so it can also travel in the response body, which
    saves the client parsing document.cookie for it.
    """
    response.set_cookie(
        REFRESH_COOKIE, refresh_token,
        max_age=sessions.REFRESH_TTL_SECONDS,
        httponly=True,             # script must never see this one
        secure=COOKIE_SECURE,
        samesite="strict",         # never needed on a cross-site request
        path=REFRESH_COOKIE_PATH,  # not attached to market-data requests
    )
    token = csrf.issue()
    response.set_cookie(
        CSRF_COOKIE, token,
        max_age=sessions.REFRESH_TTL_SECONDS,
        httponly=False,            # deliberately readable — see backend/csrf.py
        secure=COOKIE_SECURE,
        samesite="strict",
        # Site-wide, so a page at "/" can actually read it. See the note on
        # CSRF_COOKIE_PATH in backend/config.py — scoping this to the auth
        # path made it invisible to every page that needed it.
        path=CSRF_COOKIE_PATH,
    )
    return token


def clear_session(response: Response) -> None:
    # The path must match the one the cookies were set with, or the browser
    # keeps the originals and the user stays signed in after pressing sign out.
    #
    # The other attributes are repeated because delete_cookie otherwise
    # defaults to SameSite=lax and no Secure, which is a deletion that does not
    # match the cookie it is deleting. Browsers key on (name, domain, path)
    # so it works anyway today — but relying on attributes being ignored on
    # the way out, for a cookie whose whole job is being strict on the way in,
    # is the kind of detail that stops being true in one browser.
    for name, path in ((REFRESH_COOKIE, REFRESH_COOKIE_PATH),
                       (CSRF_COOKIE, CSRF_COOKIE_PATH)):
        response.delete_cookie(name, path=path,
                               secure=COOKIE_SECURE, samesite="strict",
                               httponly=(name == REFRESH_COOKIE))


def client_meta(request: Request) -> dict:
    """What the sessions list shows about a device."""
    return {
        "user_agent": request.headers.get("user-agent", ""),
        # The real client, not the reverse proxy — see backend/ratelimit.
        "ip": ratelimit.client_ip(request),
    }
