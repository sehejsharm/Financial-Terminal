"""Login, token refresh, sign-out, and the device list.

The shape here is the deliberate part. Login returns a SHORT-LIVED access
token in the response body — for the client to hold in memory, never in a
cookie — and sets the long-lived refresh token in an HttpOnly cookie the
client cannot read.

That split is the whole design:

  * XSS can no longer steal a session. It could previously read a 12-hour JWT
    straight out of `document.cookie`. The access token is now in a JS
    variable that dies with the page, and the refresh token is invisible to
    script.
  * CSRF stays mostly irrelevant. Because the access token travels as an
    Authorization header rather than a cookie, no browser attaches it
    cross-site, so the ~95 data endpoints need no CSRF defence. Only the two
    endpoints that must work BEFORE the app has an access token are
    cookie-authenticated, and those two carry the double-submit check.
  * Revocation finally means something, because the long-lived half is a
    server-side row that can be deleted.
"""
from __future__ import annotations

from fastapi import (APIRouter, Depends, HTTPException, Request, Response,
                     status)
from fastapi.responses import JSONResponse

from backend import auth, csrf, sessions
from backend.config import REFRESH_COOKIE
from backend.session_cookies import (clear_session, client_meta, set_session)
from backend.schemas import LoginRequest, LoginResponse, MeResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, response: Response):
    user = auth.authenticate(body.username, body.password)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    refresh = sessions.create(user["username"], **client_meta(request))
    csrf_token = set_session(response, refresh)
    return {**auth.issue_token(user), "csrf_token": csrf_token}


def _session_over(detail: str) -> JSONResponse:
    """A 401 that also clears the session cookies.

    This has to build and return the response itself rather than raising
    HTTPException. Cookie changes are headers on a response object, and an
    exception is turned into a DIFFERENT response further up the stack — so
    cookies set on the injected `response` before raising are silently thrown
    away. The visible symptom is a browser that keeps presenting a dead
    refresh cookie, getting 401 each time, with nothing to break the loop.
    """
    out = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED,
                       content={"detail": detail})
    clear_session(out)
    return out


@router.post("/refresh", response_model=LoginResponse)
def refresh(request: Request, response: Response):
    """Trade the refresh cookie for a new access token, rotating the cookie.

    Cookie-authenticated, so this is one of the two endpoints that needs the
    CSRF check.
    """
    csrf.require(request)
    presented = request.cookies.get(REFRESH_COOKIE)
    if not presented:
        return _session_over("No session")

    try:
        rotated = sessions.rotate(presented, **client_meta(request))
    except sessions.ReuseDetected:
        # A superseded token came back. Either the real client or someone
        # holding a copy sent it, and there is no way to tell which — so the
        # session dies and whoever is legitimate logs in again. Failing safe
        # here means a visible re-login instead of a silent handover.
        sessions.revoke(presented)
        return _session_over("This session was signed out because its token "
                             "was reused. Sign in again.")

    if rotated is None:
        return _session_over("Session expired. Sign in again.")

    new_token, record = rotated
    # The account may have been deactivated, or deleted, since the session
    # started. A refresh is the moment that has to take effect — otherwise
    # "deactivate this user" would leave them working for another 30 days.
    user = auth.user_for_session(record["username"])
    if user is None:
        sessions.revoke(new_token)
        return _session_over("This account is no longer active.")

    csrf_token = set_session(response, new_token)
    return {**auth.issue_token(user), "csrf_token": csrf_token}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response):
    """End this session. Cookie-authenticated, so CSRF-checked.

    Idempotent and never an error: a sign-out that fails because the session
    was already gone would leave a confusing message on screen for something
    the user wanted anyway.
    """
    presented = request.cookies.get(REFRESH_COOKIE)
    # No session cookie means there is nothing to destroy, so there is nothing
    # for CSRF to protect — and demanding a token here would make sign-out
    # non-idempotent, because a successful sign-out clears the CSRF cookie
    # along with the session. Checked only when a session actually exists,
    # which is the case where a forced sign-out would be a real nuisance.
    if presented:
        csrf.require(request)
        sessions.revoke(presented)
    # Cleared on the response being RETURNED. Setting them on the injected
    # `response` and then returning a new object discards the headers, and the
    # browser keeps the cookie — so the user stays signed in after pressing
    # sign out. tests/test_auth_flow.py pins this.
    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session(out)
    return out


@router.post("/logout-all")
def logout_all(request: Request, response: Response,
               user: dict = Depends(auth.current_user)):
    """Sign out everywhere, including this device.

    Authenticated with the access token rather than the cookie — this is a
    deliberate action taken from inside the app, usually after "I think
    someone else has my password", so requiring a live access token is both
    possible and a stronger check than the cookie.
    """
    ended = sessions.revoke_all(user["username"])
    clear_session(response)
    return {"sessions_ended": ended}


@router.get("/sessions")
def list_sessions(request: Request, user: dict = Depends(auth.current_user)):
    """Where this account is signed in.

    The point is that someone can recognise a device they do not recognise,
    so it reports last-used time, a truncated user agent and the IP, and marks
    which row is the current one.
    """
    return {"sessions": sessions.list_for(
        user["username"], current_token=request.cookies.get(REFRESH_COOKIE))}


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(session_id: str, user: dict = Depends(auth.current_user)):
    """End one other device. Scoped to the caller's own account in the store,
    so a guessed id cannot reach someone else's session."""
    if not sessions.revoke_session(user["username"], session_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such session")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=MeResponse)
def me(user: dict = Depends(auth.current_user)):
    return user
