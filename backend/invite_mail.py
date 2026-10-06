"""The actual invite and reset messages.

Separate from backend/mailer.py (which is transport) and from the routes
(which are policy) because the wording is the part most likely to be edited,
and it should be editable without going near either.

The register is the product's: plain, specific, no marketing adjectives. Nobody
has ever been glad to receive an email that says "Welcome aboard! We're
thrilled to have you." These say what the link does, how long it lasts, and
what to do if it was not expected.
"""
from __future__ import annotations

import os

from backend import mailer


def app_base_url() -> str:
    """Where the set-password page lives.

    Must be the front end's origin, not the API's — the link is for a human to
    click, and it opens a page. Falls back to localhost for development.
    """
    return (os.getenv("APP_BASE_URL") or "http://localhost:3000").rstrip("/")


def _link(path: str, token: str) -> str:
    return f"{app_base_url()}{path}?token={token}"


def send_invite(email: str, username: str, token: str, *,
                invited_by: str = "") -> None:
    by = f" by {invited_by}" if invited_by else ""
    mailer.send(
        email,
        "Set your Motherboard Terminal password",
        f"""An account has been created for you on Motherboard Terminal{by}.

Your username is: {username}

Set your password here — this link works once, and expires in 7 days:

{_link('/set-password', token)}

Nobody else, including whoever created the account, knows or can see your
password. That is the point: if you did not expect this email, you can ignore
it and the account stays unusable.
""",
    )


def send_reset(email: str, username: str, token: str) -> None:
    mailer.send(
        email,
        "Reset your Motherboard Terminal password",
        f"""Someone asked to reset the password for {username}.

If that was you, set a new one here — this link works once, and expires in
one hour:

{_link('/set-password', token)}

If it was not you, ignore this email. Your current password still works and
nothing has changed. Signing in anywhere will not be affected.
""",
    )
