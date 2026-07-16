"""Alert delivery channels: email (SMTP) + browser push (Web Push / VAPID).

Both channels are OPTIONAL and env-driven — with no credentials configured
the functions report unconfigured and alerts stay in-app only (bell + feed).

Email env:  SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS,
            SMTP_FROM (defaults to SMTP_USER), ALERT_EMAIL_TO
Push env:   VAPID_PRIVATE_KEY (raw base64url, from `vapid --gen` or
            `npx web-push generate-vapid-keys`), VAPID_PUBLIC_KEY,
            VAPID_SUB (mailto:you@example.com)
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
from email.message import EmailMessage

log = logging.getLogger("motherboard.notify")


def _env(name: str) -> str | None:
    v = (os.getenv(name) or "").strip()
    return v or None


# ── email ────────────────────────────────────────────────────────────────

def email_configured() -> bool:
    return bool(_env("SMTP_HOST") and _env("ALERT_EMAIL_TO"))


def send_email(subject: str, body: str) -> bool:
    if not email_configured():
        return False
    host = _env("SMTP_HOST")
    port = int(_env("SMTP_PORT") or 587)
    user = _env("SMTP_USER")
    pw = _env("SMTP_PASS")
    sender = _env("SMTP_FROM") or user or "alerts@motherboard.local"
    to = _env("ALERT_EMAIL_TO")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to
    msg.set_content(body)
    try:
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.ehlo()
            try:
                s.starttls()
                s.ehlo()
            except smtplib.SMTPNotSupportedError:
                pass  # plain SMTP relay
            if user and pw:
                s.login(user, pw)
            s.send_message(msg)
        return True
    except Exception:
        log.exception("alert email failed")
        return False


# ── web push ─────────────────────────────────────────────────────────────

def push_configured() -> bool:
    return bool(_env("VAPID_PRIVATE_KEY") and _env("VAPID_PUBLIC_KEY"))


def public_key() -> str | None:
    return _env("VAPID_PUBLIC_KEY")


def send_push(subscription: dict, title: str, body: str) -> bool:
    """Send one web-push message. Returns False when the subscription is
    dead (expired/unsubscribed) so the caller can prune it."""
    if not push_configured():
        return True  # not an error — channel simply off
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.warning("pywebpush not installed — push channel disabled")
        return True
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "url": "/alerts"}),
            vapid_private_key=_env("VAPID_PRIVATE_KEY"),
            vapid_claims={"sub": _env("VAPID_SUB") or "mailto:admin@motherboard.local"},
            timeout=15,
        )
        return True
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            return False  # dead subscription — prune
        log.warning("web push failed (%s): %s", status, e)
        return True
    except Exception:
        log.exception("web push failed")
        return True


# ── combined ─────────────────────────────────────────────────────────────

def channels() -> dict:
    return {"email": email_configured(), "push": push_configured()}
