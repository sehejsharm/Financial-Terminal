"""Transactional email, behind an adapter.

Invites and password resets are the first mail this app sends that a user is
WAITING ON. Alert emails (lib/notify.py) can fail quietly — a missed alert is a
missed alert. An invite that does not arrive means a person cannot get into the
product at all, so this path reports failure to the caller rather than logging
and shrugging.

Three implementations, chosen by MAIL_PROVIDER:

  resend   — the HTTP API, called with `requests`. Deliberately NOT the
             `resend` SDK: it is one POST with a JSON body, and taking a
             dependency to avoid writing six lines means a supply-chain
             surface and a pinned version for no benefit. Swapping vendors is
             then a new function here, not a change at any call site.
  smtp     — reuses the SMTP config lib/notify.py already has, so a deployment
             that configured alert email gets invites with no new setup.
  console  — logs the message, including the link, and reports success. This is
             the default, and it is what makes the whole invite and reset flow
             developable and testable without spending anything or mailing a
             real person by accident.

The default being `console` rather than `resend` is deliberate: a misconfigured
production deploy should fail loudly at the point someone notices no mail
arrived, not silently send from a half-configured vendor account.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger("motherboard.mailer")

RESEND_ENDPOINT = "https://api.resend.com/emails"


class MailError(Exception):
    """Sending failed. Raised rather than returned because every caller here
    has something useful to tell the user, and a bool gets ignored."""


def provider() -> str:
    return (os.getenv("MAIL_PROVIDER") or "console").strip().lower()


def from_address() -> str:
    # Resend requires a verified sending domain; the default is obviously
    # non-functional on purpose so it cannot look configured when it is not.
    return (os.getenv("MAIL_FROM") or "Motherboard <noreply@motherboard.invalid>").strip()


def send(to: str, subject: str, text: str) -> None:
    """Send one message, or raise MailError.

    Plain text only. An invite is three lines and a link; HTML mail would add
    a templating surface, a second body to keep in sync, and more ways to land
    in spam, for nothing a user wants here.
    """
    to = (to or "").strip()
    if not to or "@" not in to:
        raise MailError(f"Not a usable email address: {to!r}")

    impl = provider()
    if impl == "resend":
        _send_resend(to, subject, text)
    elif impl == "smtp":
        _send_smtp(to, subject, text)
    elif impl == "console":
        _send_console(to, subject, text)
    else:
        raise MailError(
            f"Unknown MAIL_PROVIDER {impl!r}. Expected resend, smtp or console."
        )


def _send_resend(to: str, subject: str, text: str) -> None:
    key = (os.getenv("RESEND_API_KEY") or "").strip()
    if not key:
        raise MailError("MAIL_PROVIDER=resend but RESEND_API_KEY is not set.")
    import requests
    try:
        r = requests.post(
            RESEND_ENDPOINT,
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            json={"from": from_address(), "to": [to],
                  "subject": subject, "text": text},
            timeout=15,
        )
    except Exception as exc:
        raise MailError(f"Could not reach Resend: {exc}") from exc
    if r.status_code >= 300:
        # The body carries the actual reason — an unverified sending domain is
        # the usual one — and losing it turns a five-minute fix into guesswork.
        raise MailError(f"Resend rejected the message ({r.status_code}): "
                        f"{r.text[:300]}")


def _send_smtp(to: str, subject: str, text: str) -> None:
    from lib import notify
    if not notify.email_configured():
        raise MailError("MAIL_PROVIDER=smtp but SMTP_HOST/USER/PASS are not set.")
    if not notify.send_email(subject, text, to=to):
        raise MailError("SMTP send failed — see the server log for the cause.")


def _send_console(to: str, subject: str, text: str) -> None:
    # WARNING level so it is visible without turning on debug logging: someone
    # running locally needs to find this link, and an INFO line in a chatty log
    # is effectively hidden.
    log.warning(
        "MAIL_PROVIDER=console — not sending. Would have emailed:\n"
        "  to:      %s\n  subject: %s\n%s", to, subject, text)
