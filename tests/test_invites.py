"""Invites and password resets.

This replaces the admin typing a password into a form and then getting it to
the person somehow. The properties worth pinning are the ones that make that
replacement actually better rather than merely different:

  * the admin never learns the password,
  * a pending account cannot be logged into,
  * links are single-use and expire,
  * the public endpoints cannot be used to find out who has an account,
  * and a reset ends every other session, because the reason people reset a
    password is that someone else may have it.
"""
from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ADMIN_PW = "test-pw-123"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", ADMIN_PW)
    monkeypatch.setenv("BACKEND_JWT_SECRET",
                       "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    # The default, and what makes this flow testable without a vendor account.
    monkeypatch.setenv("MAIL_PROVIDER", "console")
    import lib.auth as lib_auth
    monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
    monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
    monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH",
                        Path(tmp_path) / "INITIAL_ADMIN_PASSWORD.txt")
    lib_auth._save(lib_auth._seed())
    from backend import app as app_mod
    importlib.reload(app_mod)
    from backend import invites, sessions
    invites.configure(Path(tmp_path))
    sessions.configure(Path(tmp_path))
    return TestClient(app_mod.app)


@pytest.fixture(autouse=True)
def mailbox(monkeypatch):
    """Capture outgoing mail so a test can read the link, as the user does.

    This is the honest way to get a token: the store holds only hashes, and
    the plaintext exists in exactly one place — the email. Reaching into the
    store and re-minting would test a path no user takes, and would hide a
    broken link format.
    """
    sent: list[dict] = []

    def fake_send(to, subject, text):
        sent.append({"to": to, "subject": subject, "text": text})

    monkeypatch.setattr("backend.mailer.send", fake_send)
    return sent


def token_from(mailbox) -> str:
    assert mailbox, "no email was sent"
    found = re.search(r"token=([A-Za-z0-9_-]+)", mailbox[-1]["text"])
    assert found, f"no token link in the email:\n{mailbox[-1]['text']}"
    return found.group(1)


@pytest.fixture
def admin(client):
    tok = client.post("/api/v1/auth/login",
                      json={"username": "admin",
                            "password": ADMIN_PW}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def invite(client, admin, mailbox, username="newbie", email="new@example.com"):
    """Invite a user and return the token from the email they received."""
    r = client.post("/api/v1/admin/invites", headers=admin,
                    json={"username": username, "email": email})
    assert r.status_code == 201, r.text
    return token_from(mailbox)


class TestInviting:
    def test_creates_the_account(self, client, admin, mailbox):
        invite(client, admin, mailbox)
        users = client.get("/api/v1/admin/users", headers=admin).json()
        assert any(u["username"] == "newbie" for u in users)

    def test_the_account_is_marked_pending(self, client, admin, mailbox):
        invite(client, admin, mailbox)
        users = client.get("/api/v1/admin/users", headers=admin).json()
        assert next(u for u in users if u["username"] == "newbie")["pending"]

    def test_a_pending_account_cannot_be_logged_into(self, client, admin, mailbox):
        # The security claim. There is no password, and the stored hash is of
        # a random value nobody has seen, so there is nothing to guess.
        invite(client, admin, mailbox)
        for attempt in ("", "password", "newbie", "123456"):
            r = client.post("/api/v1/auth/login",
                            json={"username": "newbie", "password": attempt})
            assert r.status_code == 401, f"logged in with {attempt!r}"

    def test_the_admin_never_supplies_a_password(self, client, admin, mailbox):
        # The request body has no password field at all — so there is nothing
        # to deliver over chat and nothing left in anyone's scrollback.
        r = client.post("/api/v1/admin/invites", headers=admin,
                        json={"username": "x", "email": "x@example.com"})
        assert r.status_code == 201

    def test_inviting_requires_master_admin(self, client):
        r = client.post("/api/v1/admin/invites",
                        json={"username": "x", "email": "x@example.com"})
        assert r.status_code in (401, 403)

    def test_a_duplicate_username_is_refused(self, client, admin, mailbox):
        invite(client, admin, mailbox)
        r = client.post("/api/v1/admin/invites", headers=admin,
                        json={"username": "newbie", "email": "a@example.com"})
        assert r.status_code == 400

    def test_a_failed_send_is_reported_not_swallowed(self, client, admin, monkeypatch):
        # The admin is the only person who can tell. Reporting success would
        # leave a user who never hears anything and an admin who thinks the
        # job is done.
        from backend import mailer

        def boom(to, subject, text):
            raise mailer.MailError("sending domain not verified")

        monkeypatch.setattr("backend.mailer.send", boom)
        r = client.post("/api/v1/admin/invites", headers=admin,
                        json={"username": "unreachable", "email": "u@example.com"})
        assert r.status_code == 502
        assert "could not be sent" in r.json()["detail"]
        assert "not verified" in r.json()["detail"], "the vendor's reason is lost"


class TestAcceptingAnInvite:
    def test_sets_the_password_and_signs_the_user_in(self, client, admin, mailbox):
        token = invite(client, admin, mailbox)
        r = client.post("/api/v1/auth/invite/accept",
                        json={"token": token, "password": "a-good-password"})
        assert r.status_code == 200, r.text
        assert r.json()["access_token"]

    def test_the_new_password_then_works(self, client, admin, mailbox):
        token = invite(client, admin, mailbox)
        client.post("/api/v1/auth/invite/accept",
                    json={"token": token, "password": "a-good-password"})
        r = client.post("/api/v1/auth/login",
                        json={"username": "newbie", "password": "a-good-password"})
        assert r.status_code == 200

    def test_the_account_is_no_longer_pending(self, client, admin, mailbox):
        token = invite(client, admin, mailbox)
        client.post("/api/v1/auth/invite/accept",
                    json={"token": token, "password": "a-good-password"})
        users = client.get("/api/v1/admin/users", headers=admin).json()
        assert not next(u for u in users if u["username"] == "newbie")["pending"]

    def test_a_link_works_only_once(self, client, admin, mailbox):
        token = invite(client, admin, mailbox)
        client.post("/api/v1/auth/invite/accept",
                    json={"token": token, "password": "a-good-password"})
        r = client.post("/api/v1/auth/invite/accept",
                        json={"token": token, "password": "another-password"})
        assert r.status_code == 404

    def test_inspecting_a_link_does_not_spend_it(self, client, admin, mailbox):
        # A mail client prefetching the URL, or the user opening it twice,
        # must not burn the one use they need for the submit.
        token = invite(client, admin, mailbox)
        for _ in range(3):
            assert client.get(f"/api/v1/auth/invite?token={token}").status_code == 200
        r = client.post("/api/v1/auth/invite/accept",
                        json={"token": token, "password": "a-good-password"})
        assert r.status_code == 200

    def test_inspecting_tells_the_page_whose_account_it_is(self, client, admin, mailbox):
        token = invite(client, admin, mailbox)
        body = client.get(f"/api/v1/auth/invite?token={token}").json()
        assert body["username"] == "newbie"

    def test_an_unknown_token_is_refused(self, client):
        assert client.get("/api/v1/auth/invite?token=made-up").status_code == 404

    def test_the_refusal_does_not_say_which_kind_of_invalid(self, client, admin, mailbox):
        # Expired, already-used and never-existed must read identically, or
        # the difference confirms which tokens were once real.
        used = invite(client, admin, mailbox)
        client.post("/api/v1/auth/invite/accept",
                    json={"token": used, "password": "a-good-password"})
        a = client.get(f"/api/v1/auth/invite?token={used}").json()["detail"]
        b = client.get("/api/v1/auth/invite?token=never-existed").json()["detail"]
        assert a == b

    def test_a_weak_password_is_refused(self, client, admin, mailbox):
        token = invite(client, admin, mailbox)
        r = client.post("/api/v1/auth/invite/accept",
                        json={"token": token, "password": "abc"})
        assert r.status_code == 400

    def test_an_expired_invite_is_refused(self, client, admin, mailbox, monkeypatch):
        from backend import invites as inv
        monkeypatch.setitem(inv.TTL_SECONDS, inv.PURPOSE_INVITE, -1)
        token = invite(client, admin, mailbox)
        r = client.post("/api/v1/auth/invite/accept",
                        json={"token": token, "password": "a-good-password"})
        assert r.status_code == 404

    def test_an_invite_token_cannot_be_used_as_a_reset(self, client, admin, mailbox):
        # They are indistinguishable strings; the purpose check is the only
        # thing keeping them from being interchangeable.
        token = invite(client, admin, mailbox)
        r = client.post("/api/v1/auth/invite/accept?purpose=reset",
                        json={"token": token, "password": "a-good-password"})
        assert r.status_code == 404


class TestResend:
    def test_a_resent_invite_invalidates_the_previous_link(self, client, admin, mailbox):
        # Otherwise "resend" leaves several valid ways in and the oldest email
        # in the mailbox stays one of them.
        first = invite(client, admin, mailbox)
        r = client.post("/api/v1/admin/invites/newbie/resend", headers=admin)
        assert r.status_code == 200, r.text
        assert client.get(f"/api/v1/auth/invite?token={first}").status_code == 404

    def test_resend_requires_an_email_on_file(self, client, admin, mailbox):
        import lib.auth as lib_auth
        lib_auth.create_user("no-email", "a-password")
        r = client.post("/api/v1/admin/invites/no-email/resend", headers=admin)
        assert r.status_code == 400


class TestForgotPassword:
    def test_always_answers_the_same_for_a_real_account(self, client, admin, mailbox):
        invite(client, admin, mailbox)
        r = client.post("/api/v1/auth/forgot-password",
                        json={"email": "new@example.com"})
        assert r.status_code == 200

    def test_an_unknown_account_answers_identically(self, client, admin, mailbox):
        # The enumeration property. A "no such user" here would hand over a
        # list of who banks with us.
        invite(client, admin, mailbox)
        real = client.post("/api/v1/auth/forgot-password",
                           json={"email": "new@example.com"}).json()
        fake = client.post("/api/v1/auth/forgot-password",
                           json={"email": "nobody@example.com"}).json()
        assert real == fake

    def test_an_account_with_no_email_also_answers_identically(self, client):
        import lib.auth as lib_auth
        lib_auth.create_user("emailless", "a-password")
        a = client.post("/api/v1/auth/forgot-password",
                        json={"username": "emailless"}).json()
        b = client.post("/api/v1/auth/forgot-password",
                        json={"username": "no-such-person"}).json()
        assert a == b

    def test_an_empty_request_is_not_an_error(self, client):
        assert client.post("/api/v1/auth/forgot-password", json={}).status_code == 200

    def test_a_reset_ends_every_other_session(self, client, admin, mailbox):
        from backend import sessions
        token = invite(client, admin, mailbox)
        client.post("/api/v1/auth/invite/accept",
                    json={"token": token, "password": "a-good-password"})
        # Two other devices signed in as this user.
        sessions.create("newbie", user_agent="Phone")
        sessions.create("newbie", user_agent="Laptop")
        client.post("/api/v1/auth/forgot-password",
                    json={"email": "new@example.com"})
        reset = token_from(mailbox)
        r = client.post("/api/v1/auth/invite/accept?purpose=reset",
                        json={"token": reset, "password": "brand-new-password"})
        assert r.status_code == 200, r.text
        # The reason people reset a password is that someone else may have it.
        # Exactly one session survives: the one just created by this request.
        assert len(sessions.list_for("newbie")) == 1


class TestDeactivationRevokesEverything:
    def test_a_pending_invite_dies_with_the_account(self, client, admin, mailbox):
        # Otherwise the invite sits in a mailbox as a way into a disabled
        # account.
        token = invite(client, admin, mailbox)
        assert client.delete("/api/v1/admin/users/newbie",
                             headers=admin).status_code == 204
        assert client.get(f"/api/v1/auth/invite?token={token}").status_code == 404

    def test_live_sessions_die_with_the_account(self, client, admin, mailbox):
        from backend import sessions
        token = invite(client, admin, mailbox)
        client.post("/api/v1/auth/invite/accept",
                    json={"token": token, "password": "a-good-password"})
        assert sessions.list_for("newbie")
        client.delete("/api/v1/admin/users/newbie", headers=admin)
        assert sessions.list_for("newbie") == []
