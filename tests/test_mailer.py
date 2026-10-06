"""The mail transport adapter, independent of the invite flow.

Its own file because tests/test_invites.py stubs backend.mailer.send for the
whole module — which is right there (those tests are about the invite flow and
need to read the message) and wrong here (these are about transport, and need
the real function).
"""
from __future__ import annotations

import pytest

from backend import mailer


def test_console_is_the_default(monkeypatch):
    monkeypatch.delenv("MAIL_PROVIDER", raising=False)
    # Defaulting to console rather than a real vendor means a half-configured
    # production deploy fails where someone notices, instead of quietly
    # sending from a wrong or unverified account.
    assert mailer.provider() == "console"


def test_resend_without_a_key_is_a_clear_error(monkeypatch):
    monkeypatch.setenv("MAIL_PROVIDER", "resend")
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    with pytest.raises(mailer.MailError, match="RESEND_API_KEY"):
        mailer.send("a@example.com", "s", "t")


def test_an_unknown_provider_is_refused_rather_than_ignored(monkeypatch):
    # Silently falling back would mean a typo in MAIL_PROVIDER looks like
    # working mail that never arrives.
    monkeypatch.setenv("MAIL_PROVIDER", "mailgun")
    with pytest.raises(mailer.MailError, match="Unknown MAIL_PROVIDER"):
        mailer.send("a@example.com", "s", "t")


def test_a_bad_address_is_refused_before_any_transport(monkeypatch):
    monkeypatch.setenv("MAIL_PROVIDER", "resend")
    with pytest.raises(mailer.MailError, match="usable email"):
        mailer.send("not-an-address", "s", "t")


def test_console_reports_success(monkeypatch):
    monkeypatch.setenv("MAIL_PROVIDER", "console")
    mailer.send("a@example.com", "s", "t")   # must not raise


def test_smtp_without_configuration_is_a_clear_error(monkeypatch):
    monkeypatch.setenv("MAIL_PROVIDER", "smtp")
    monkeypatch.setattr("lib.notify.email_configured", lambda: False)
    with pytest.raises(mailer.MailError, match="SMTP_HOST"):
        mailer.send("a@example.com", "s", "t")


def test_the_default_from_address_is_obviously_not_configured(monkeypatch):
    # .invalid is reserved and can never resolve, so a deploy that forgets
    # MAIL_FROM fails visibly rather than sending from something plausible.
    monkeypatch.delenv("MAIL_FROM", raising=False)
    assert ".invalid" in mailer.from_address()
