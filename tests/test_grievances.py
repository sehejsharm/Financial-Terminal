"""The complaint channel.

A grievance mechanism that is only an email address gives the user no evidence
they complained and gives us no record we can be held to. Both matter if a
complaint is escalated to SEBI's SCORES platform, where the first question is
what we did and when.

The property worth pinning hardest is the ORDER: the complaint is written to
disk before the acknowledgement is sent, so a mail outage cannot lose a
complaint the user holds a reference for.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

COMPLAINT = "The screener returned nothing for RELIANCE.NS for three days."


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", "test-pw-123")
    monkeypatch.setenv("BACKEND_JWT_SECRET",
                       "test-secret-do-not-use-at-least-32-bytes-long-aaaaaaaa")
    monkeypatch.setenv("MAIL_PROVIDER", "console")
    import lib.auth as lib_auth
    monkeypatch.setattr(lib_auth, "DATA_DIR", Path(tmp_path))
    monkeypatch.setattr(lib_auth, "USERS_PATH", Path(tmp_path) / "users.json")
    monkeypatch.setattr(lib_auth, "INITIAL_PW_PATH", Path(tmp_path) / "pw.txt")
    lib_auth._save(lib_auth._seed())
    from backend import app as app_mod
    importlib.reload(app_mod)
    from backend.routes import support
    support.configure(Path(tmp_path))
    from backend import ratelimit
    ratelimit._hits.clear()
    return TestClient(app_mod.app)


def file_one(client, body=COMPLAINT, email="user@example.com"):
    return client.post("/api/v1/support/grievance",
                       json={"body": body, "email": email})


class TestFiling:
    def test_a_complaint_returns_a_reference(self, client):
        r = file_one(client)
        assert r.status_code == 200, r.text
        assert r.json()["reference"].startswith("MB-")

    def test_it_works_without_logging_in(self, client):
        # The people most likely to need this are the ones who cannot get in:
        # a failed invite, a reset that never arrived, a deactivated account.
        # Requiring a login to report that you cannot log in excludes exactly
        # the complaints this exists for.
        assert file_one(client).status_code == 200

    def test_the_complaint_is_persisted(self, client):
        from backend.routes import support
        ref = file_one(client).json()["reference"]
        import json
        stored = json.loads(support._path.read_text())["grievances"]
        assert any(g["reference"] == ref and g["body"] == COMPLAINT
                   for g in stored)

    def test_each_reference_is_distinct(self, client):
        a = file_one(client).json()["reference"]
        b = file_one(client).json()["reference"]
        assert a != b

    def test_the_record_opens_in_the_open_state(self, client):
        from backend.routes import support
        import json
        file_one(client)
        assert json.loads(support._path.read_text())["grievances"][0]["status"] \
            == "open"

    def test_the_user_is_emailed_their_reference(self, client, monkeypatch):
        sent = []
        monkeypatch.setattr("backend.mailer.send",
                            lambda to, subject, text: sent.append((to, text)))
        ref = file_one(client).json()["reference"]
        assert sent, "no acknowledgement was sent"
        assert ref in sent[0][1]

    def test_the_acknowledgement_names_the_escalation_route(self, client,
                                                            monkeypatch):
        # Escalation must not depend on us telling them about it later.
        sent = []
        monkeypatch.setattr("backend.mailer.send",
                            lambda to, subject, text: sent.append(text))
        file_one(client)
        assert "scores.sebi.gov.in" in sent[0]


class TestItSurvivesAMailOutage:
    def test_a_complaint_is_recorded_even_if_the_email_fails(self, client,
                                                             monkeypatch):
        """The order that matters.

        Written to disk BEFORE the acknowledgement is sent. Emailing first and
        storing second would mean an outage loses the record while the user
        holds a reference for something we have no trace of.
        """
        from backend import mailer
        from backend.routes import support
        import json

        def boom(to, subject, text):
            raise mailer.MailError("provider down")

        monkeypatch.setattr("backend.mailer.send", boom)
        r = file_one(client)
        # The user is NOT told it failed: the complaint is recorded, which is
        # what they need, and an error would invite them to file it again.
        assert r.status_code == 200
        ref = r.json()["reference"]
        stored = json.loads(support._path.read_text())["grievances"]
        assert any(g["reference"] == ref for g in stored)

    def test_a_storage_failure_is_reported_honestly(self, client, monkeypatch):
        # The opposite case. If we cannot record it, saying "filed" would be a
        # lie about the one thing the user is relying on.
        def boom(record):
            raise OSError("disk full")

        monkeypatch.setattr("backend.routes.support._store", boom)
        r = file_one(client)
        assert r.status_code == 503
        assert "Email us directly" in r.json()["detail"]


class TestValidation:
    def test_a_missing_email_is_refused(self, client):
        r = client.post("/api/v1/support/grievance", json={"body": COMPLAINT})
        assert r.status_code == 422

    def test_a_non_address_is_refused(self, client):
        r = file_one(client, email="not-an-address")
        assert r.status_code == 400

    def test_an_empty_complaint_is_refused(self, client):
        assert file_one(client, body="x").status_code == 422

    def test_an_enormous_complaint_is_refused(self, client):
        # Public and writes to the data volume, so the field is bounded. The
        # body-size middleware also caps it; this gives a clearer message.
        assert file_one(client, body="x" * 6000).status_code == 422


class TestRateLimiting:
    def test_it_cannot_be_used_to_fill_the_disk_or_mail_bomb(self, client):
        from backend import ratelimit
        ratelimit._hits.clear()
        codes = [file_one(client).status_code for _ in range(12)]
        assert 429 in codes, "a public, disk-writing, mail-sending endpoint " \
                             "has no ceiling"
        ratelimit._hits.clear()


class TestTheComplaintIsReachable:
    def test_the_endpoint_is_on_the_reviewed_public_list(self):
        # A complaint channel behind authentication, or one that the route
        # audit flags as an accident, is not a complaint channel.
        from tests.test_public_endpoints import INTENTIONALLY_PUBLIC
        from backend import plans  # noqa: F401  (import smoke)
        assert "/api/v1/support/grievance" in INTENTIONALLY_PUBLIC
