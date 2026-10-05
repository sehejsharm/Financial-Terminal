"""CSRF protection for the cookie-authenticated endpoints — and only those.

Worth being precise about the scope, because "add CSRF protection" is usually
read as "to every endpoint" and that would be wasted work here.

CSRF exists because browsers attach cookies to cross-site requests
automatically. Almost every endpoint in this API authenticates with an
`Authorization: Bearer` header, which a browser never attaches on its own — an
attacker's page cannot make the victim's browser produce that header, so those
endpoints are CSRF-immune by construction. Protecting them would add a failure
mode and no security. (Keeping the access token OUT of a cookie is what buys
this, and is the reason it is deliberately held in memory on the client rather
than being made an HttpOnly cookie.)

What IS cookie-authenticated is the refresh endpoint and sign-out, because
those must work before the app holds an access token. Those are the ones that
need defending, and they are the ones this covers.

The scheme is double-submit: a random value in a readable cookie, echoed back
in a header. A cross-site attacker can cause the COOKIE to be sent but cannot
read it to set the HEADER — that is the same-origin policy, not a trick — so a
forged request arrives with a cookie and no matching header. This is why the
CSRF cookie is deliberately NOT HttpOnly: the app has to read it. That is safe
in a way the session cookie is not, because the value is worthless on its own.

SameSite=Strict on the refresh cookie already blocks this class of attack in
every browser that honours it. This is the second lock: it holds if the cookie
attribute is ever loosened by accident, and it does not depend on browser
behaviour we do not control.
"""
from __future__ import annotations

import hmac
import secrets

from fastapi import HTTPException, Request, status

from backend.config import CSRF_COOKIE, CSRF_HEADER

_TOKEN_BYTES = 32


def issue() -> str:
    """A fresh CSRF token, to be set as a readable cookie."""
    return secrets.token_urlsafe(_TOKEN_BYTES)


def require(request: Request) -> None:
    """Reject the request unless cookie and header agree.

    Raises 403 rather than 401: the caller's credentials may be perfectly
    valid: what is wrong is where the request came from, and answering 401
    would send a client into a re-authentication loop that cannot fix it.
    """
    cookie = request.cookies.get(CSRF_COOKIE)
    header = request.headers.get(CSRF_HEADER)
    if not cookie or not header:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Missing CSRF token. Send the value of the "
            f"{CSRF_COOKIE} cookie in the {CSRF_HEADER} header.",
        )
    # Constant-time: a timing oracle on this comparison would let an attacker
    # discover the token a character at a time, which is the one way a
    # double-submit scheme falls over.
    if not hmac.compare_digest(cookie, header):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token mismatch.")
