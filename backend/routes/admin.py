"""Admin endpoints — list users, create users, view audit log.

All guarded by require_master_admin.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend import auth, invites, mailer
from backend.invite_mail import send_invite
from backend.schemas import CreateUserRequest, InviteRequest
from backend.storage import get_storage
from lib import auth as user_store

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users")
def list_users(_user: dict = Depends(auth.require_master_admin)):
    return user_store.list_users()


def _audit_action(actor: dict, action: str, target: str, detail: str = "") -> None:
    """Explicit audit event for sensitive admin actions — the request-level
    middleware only records method+path, which loses the affected user for
    body-carried operations like user creation."""
    from datetime import datetime, timezone
    try:
        get_storage().append_audit({
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "user": actor.get("username"), "method": "ACTION",
            "path": f"admin:{action}:{target}", "query": detail or None,
            "status": 200, "latency_ms": 0,
        })
    except Exception:
        pass  # auditing must never break the action itself


def _validated_role(claimed: str) -> str:
    # Anything but the two known roles demotes to plain user — the client's
    # claim is never trusted.
    return claimed if claimed in (user_store.ROLE_USER,
                                  user_store.ROLE_MASTER) else user_store.ROLE_USER


@router.post("/invites", status_code=201)
def invite_user(body: InviteRequest,
                user: dict = Depends(auth.require_master_admin)):
    """Create an account with no password and email the owner a link to set one.

    The preferred way to add a user. The admin never learns the password, so
    there is nothing to deliver over chat and nothing left in anyone's
    scrollback — and the user has a secret only they know, which is what makes
    "your account did this" mean anything.
    """
    role = _validated_role(body.role)
    ok, msg = user_store.create_user(body.username, None, role, email=body.email)
    if not ok:
        raise HTTPException(400, msg)
    token = invites.issue(body.username, body.email, invites.PURPOSE_INVITE,
                          role=role, invited_by=user.get("username", ""))
    try:
        send_invite(body.email, body.username, token,
                    invited_by=user.get("username", ""))
    except mailer.MailError as exc:
        # The account exists but the invite did not go out. Say so plainly
        # instead of reporting success: the admin is the only person who can
        # tell, and a silent failure means a user who never hears anything and
        # an admin who thinks the job is done.
        _audit_action(user, "invite_send_failed", body.username, str(exc)[:200])
        raise HTTPException(
            502,
            f"Account '{body.username}' was created, but the invite email "
            f"could not be sent: {exc}. Use resend once mail is working.",
        )
    _audit_action(user, "user_invited", body.username,
                  f"role={role} email={body.email}")
    return {"ok": True, "message": f"Invited {body.username} at {body.email}."}


@router.post("/invites/{username}/resend", status_code=200)
def resend_invite(username: str,
                  user: dict = Depends(auth.require_master_admin)):
    """Issue a fresh invite link for an account that has not set a password.

    Issuing invalidates the previous token, so an old email stops working —
    otherwise "resend" would leave several valid ways in, and the oldest
    message in the mailbox would stay one of them.
    """
    record = user_store.get_user(username)
    if record is None:
        raise HTTPException(404, "No such active user.")
    email = user_store.email_for(username)
    if not email:
        raise HTTPException(400, f"No email address on file for '{username}'.")
    token = invites.issue(username, email, invites.PURPOSE_INVITE,
                          invited_by=user.get("username", ""))
    try:
        send_invite(email, username, token, invited_by=user.get("username", ""))
    except mailer.MailError as exc:
        raise HTTPException(502, f"Could not send the invite: {exc}")
    _audit_action(user, "invite_resent", username, f"email={email}")
    return {"ok": True, "message": f"New invite sent to {email}."}


@router.post("/users", status_code=201)
def create_user(body: CreateUserRequest,
                user: dict = Depends(auth.require_master_admin)):
    """Create a user directly. DEPRECATED in favour of POST /admin/invites.

    Kept working because the existing admin screen posts to it, and breaking a
    working surface to improve a different one is not a trade worth making.
    With no password it now behaves like an invite (and requires an email);
    with one it does what it always did.
    """
    role = _validated_role(body.role)
    if body.password is None:
        if not body.email:
            raise HTTPException(
                400, "Either a password or an email address is required — "
                     "with an email, the user is invited and sets their own.")
        return invite_user(
            InviteRequest(username=body.username, email=body.email, role=role),
            user)
    ok, msg = user_store.create_user(body.username, body.password, role,
                                     email=body.email or "")
    if not ok:
        raise HTTPException(400, msg)
    _audit_action(user, "user_created", body.username, f"role={role}")
    return {"ok": True, "message": msg}


@router.delete("/users/{username}", status_code=204)
def deactivate(username: str, user: dict = Depends(auth.require_master_admin)):
    user_store.set_active(username, False)
    # Everything that could let this account back in has to go at the same
    # moment, or deactivation is only partial: a live session would keep
    # working until its refresh token expired, and a pending invite or reset
    # link would sit in a mailbox as a way into a disabled account.
    from backend import sessions
    ended = sessions.revoke_all(username)
    tokens = invites.revoke_for(username)
    _audit_action(user, "user_deactivated", username,
                  f"sessions_ended={ended} tokens_revoked={tokens}")


@router.get("/audit")
def audit(limit: int = 200,
          _user: dict = Depends(auth.require_master_admin)):
    return get_storage().recent_audit(limit=limit)


@router.get("/performance")
def performance(limit: int = 40,
                _user: dict = Depends(auth.require_master_admin)):
    """Slow-request and timeout telemetry.

    Exists because the Macro → Sectors tab could hang forever and the only
    way anyone found out was a user watching a spinner. Requests past the
    slow threshold and every request that hit the deadline are counted here,
    so a hang shows up as a number on this page.
    """
    from backend.reliability import slow_report
    return slow_report(limit=limit)


@router.delete("/performance", status_code=204)
def reset_performance(user: dict = Depends(auth.require_master_admin)):
    from backend.reliability import reset_report
    reset_report()
    _audit_action(user, "performance_stats_reset", "")


@router.get("/nse-probe/{ticker}")
def nse_probe(ticker: str, quarterly: bool = True, max_docs: int = 2,
             prefer: str | None = None,
             _user: dict = Depends(auth.require_master_admin)):
    """A results filing's raw XBRL next to how it got parsed.

    The first run of this endpoint is what showed that
    /api/corporates-financial-results is an announcement index carrying no
    line items at all — every field it returns is metadata, which is why all
    twelve statement lines came back unmapped. The numbers are in the XBRL
    document that index links to, and this now reports on that document.

    Read the response in this order:

      documents[].consistency  — the filing's own identities. Revenue plus
        other income IS total income in any real filing, whatever the tags
        are called, and net income over EPS has to give a believable share
        count. All `ok` means the mapping is right; a `MISMATCH` names which
        identity broke, which is a mismapped line or a scale error.
      documents[].unmapped_lines — lines with no tag found. Some are genuine
        (a bank files no `Depreciation`); the rest are wrong guesses.
      documents[].all_numeric_facts — every tag present in that period,
        largest first. This is the definitive answer for anything unmapped:
        the real element name is in this list.

    A company files each quarter twice, parent and group. `selected_index`
    and `documents[].primary` say which one downstream code should treat as
    the company's figures; consolidated wins by default, standalone for the
    banks in `nse_financials.PREFER_STANDALONE`. `prefer=standalone` or
    `prefer=consolidated` overrides that for one call.
    """
    from lib import nse_financials
    if prefer not in (None, nse_financials.CONSOLIDATED, nse_financials.STANDALONE):
        raise HTTPException(400, "prefer must be consolidated or standalone")
    return nse_financials.probe(ticker, quarterly=quarterly, max_docs=max_docs,
                                prefer=prefer)
