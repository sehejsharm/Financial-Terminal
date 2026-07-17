"""Alert delivery channels: email (SMTP), Telegram ("text"), browser push.

All channels are OPTIONAL. Configuration comes from EITHER environment
variables OR the runtime settings file (data/notify_settings.json), which the
master admin edits from the web UI — no shell access needed. Env always wins
when both are set.

Email env:    SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS,
              SMTP_FROM (defaults to SMTP_USER), ALERT_EMAIL_TO (fallback
              recipient; per-user addresses set in the Alerts UI take priority)
Telegram env: TELEGRAM_BOT_TOKEN (from @BotFather — free)
Push env:     VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUB (mailto:…)
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
import threading
from email.message import EmailMessage
from pathlib import Path

import requests

log = logging.getLogger("motherboard.notify")

# Same data dir the backend uses (backend/config.py: BASE_DIR / "data").
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_SETTINGS_PATH = _DATA_DIR / "notify_settings.json"
_lock = threading.RLock()

# Settings keys the admin UI may store. Anything else is dropped on save.
SETTING_KEYS = (
    "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from",
    "alert_email_to", "telegram_bot_token",
)
_SECRET_KEYS = {"smtp_pass", "telegram_bot_token"}


def load_settings() -> dict:
    with _lock:
        try:
            return json.loads(_SETTINGS_PATH.read_text())
        except Exception:
            return {}


def save_settings(new: dict) -> dict:
    """Merge + persist UI-managed settings. Blank string clears a key."""
    with _lock:
        cur = load_settings()
        for k in SETTING_KEYS:
            if k in new:
                v = (str(new[k]).strip() if new[k] is not None else "")
                if v:
                    cur[k] = v
                else:
                    cur.pop(k, None)
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        _SETTINGS_PATH.write_text(json.dumps(cur, indent=2))
        try:
            os.chmod(_SETTINGS_PATH, 0o600)
        except OSError:
            pass
        return cur


def masked_settings() -> dict:
    """Settings for the admin UI — secrets replaced with a set/unset flag."""
    cur = load_settings()
    out = {}
    for k in SETTING_KEYS:
        env_name = k.upper()
        from_env = bool((os.getenv(env_name) or "").strip())
        val = cur.get(k)
        if k in _SECRET_KEYS:
            out[k] = "•••set•••" if (val or from_env) else ""
        else:
            out[k] = (os.getenv(env_name) or "").strip() or val or ""
    return out


def _cfg(name: str) -> str | None:
    """Env var first (SMTP_HOST), then the settings file (smtp_host)."""
    v = (os.getenv(name) or "").strip()
    if v:
        return v
    v = str(load_settings().get(name.lower()) or "").strip()
    return v or None


# ── email ────────────────────────────────────────────────────────────────

def email_configured() -> bool:
    return bool(_cfg("SMTP_HOST") and _cfg("SMTP_USER") and _cfg("SMTP_PASS"))


def send_email(subject: str, body: str, to: str | None = None) -> bool:
    """Send to `to` (per-user address) or the ALERT_EMAIL_TO fallback."""
    to = (to or "").strip() or _cfg("ALERT_EMAIL_TO")
    if not email_configured() or not to:
        return False
    host = _cfg("SMTP_HOST")
    port = int(_cfg("SMTP_PORT") or 587)
    user = _cfg("SMTP_USER")
    pw = _cfg("SMTP_PASS")
    sender = _cfg("SMTP_FROM") or user or "alerts@motherboard.local"
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


# ── telegram (free "text message" channel) ───────────────────────────────

_TG_API = "https://api.telegram.org/bot{token}/{method}"


def telegram_configured() -> bool:
    return bool(_cfg("TELEGRAM_BOT_TOKEN"))


def telegram_bot_username() -> str | None:
    """The bot's @username — shown in the UI so users know who to message."""
    token = _cfg("TELEGRAM_BOT_TOKEN")
    if not token:
        return None
    try:
        r = requests.get(_TG_API.format(token=token, method="getMe"), timeout=(5, 10))
        if r.status_code == 200:
            return r.json().get("result", {}).get("username")
    except Exception:
        log.warning("telegram getMe failed", exc_info=True)
    return None


def send_telegram(chat_id: int | str, text: str) -> bool:
    token = _cfg("TELEGRAM_BOT_TOKEN")
    if not token or not chat_id:
        return False
    try:
        r = requests.post(
            _TG_API.format(token=token, method="sendMessage"),
            json={"chat_id": chat_id, "text": text},
            timeout=(5, 15),
        )
        return r.status_code == 200
    except Exception:
        log.exception("telegram send failed")
        return False


def telegram_find_chat(code: str) -> int | None:
    """Scan recent bot messages for the given link code and return the
    sender's chat id. Powers the no-webhook account-linking flow: the UI
    shows the user a code, they send it to the bot, then click Verify."""
    token = _cfg("TELEGRAM_BOT_TOKEN")
    if not token or not code:
        return None
    try:
        r = requests.get(
            _TG_API.format(token=token, method="getUpdates"),
            params={"limit": 100},
            timeout=(5, 15),
        )
        if r.status_code != 200:
            return None
        needle = code.strip().upper()
        # Newest last — walk backwards so the latest sender of the code wins.
        for upd in reversed(r.json().get("result", [])):
            msg = upd.get("message") or {}
            text = str(msg.get("text") or "").upper()
            if needle and needle in text:
                chat = msg.get("chat") or {}
                if chat.get("id") is not None:
                    return chat["id"]
    except Exception:
        log.exception("telegram getUpdates failed")
    return None


# ── web push ─────────────────────────────────────────────────────────────

def push_configured() -> bool:
    return bool(_cfg("VAPID_PRIVATE_KEY") and _cfg("VAPID_PUBLIC_KEY"))


def public_key() -> str | None:
    return _cfg("VAPID_PUBLIC_KEY")


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
            vapid_private_key=_cfg("VAPID_PRIVATE_KEY"),
            vapid_claims={"sub": _cfg("VAPID_SUB") or "mailto:admin@motherboard.local"},
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
    return {"email": email_configured(), "push": push_configured(),
            "telegram": telegram_configured()}
