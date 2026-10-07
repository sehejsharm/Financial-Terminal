"""The session store: rotation, reuse detection, revocation.

The store exists so that a login can be withdrawn. Before it, a JWT was valid
for its full 12-hour life whatever happened — deactivating an account, changing
a password, or learning that a token had been stolen all did nothing until it
expired.

The tests that matter most here are the reuse-detection ones, because that is
the part with a subtle failure mode: get it wrong in one direction and two
browser tabs sign the user out; get it wrong in the other and a stolen token
rides along forever while the real user is quietly logged out.
"""
from __future__ import annotations

import time

import pytest

from backend import sessions


@pytest.fixture(autouse=True)
def store(tmp_path):
    sessions.configure(tmp_path)
    yield
    sessions.configure(tmp_path)


class TestCreateAndGet:
    def test_a_new_session_resolves_from_its_token(self):
        tok = sessions.create("alice", user_agent="Firefox", ip="203.0.113.1")
        rec = sessions.get(tok)
        assert rec is not None
        assert rec["username"] == "alice"

    def test_the_plaintext_token_is_never_stored(self):
        # A leaked store must not hand over live sessions.
        tok = sessions.create("alice")
        raw = (sessions._path).read_text()
        assert tok not in raw

    def test_an_unknown_token_resolves_to_nothing(self):
        sessions.create("alice")
        assert sessions.get("not-a-real-token") is None

    def test_two_logins_are_two_sessions(self):
        a = sessions.create("alice", user_agent="Firefox")
        b = sessions.create("alice", user_agent="Safari")
        assert a != b
        assert len(sessions.list_for("alice")) == 2


class TestRotation:
    def test_rotating_returns_a_new_token(self):
        tok = sessions.create("alice")
        new, rec = sessions.rotate(tok)
        assert new != tok
        assert rec["username"] == "alice"

    def test_the_new_token_works(self):
        tok = sessions.create("alice")
        new, _ = sessions.rotate(tok)
        assert sessions.get(new) is not None

    def test_the_old_token_no_longer_authenticates(self):
        # It is still *recognised* — that is what reuse detection needs — but
        # it must not be usable to prove identity.
        tok = sessions.create("alice")
        sessions.rotate(tok)
        assert sessions.get(tok) is None

    def test_rotation_keeps_one_session_not_many(self):
        # The sessions list is per device. If rotation created a row each time,
        # one login would show up as dozens of devices.
        tok = sessions.create("alice")
        for _ in range(5):
            tok, _ = sessions.rotate(tok)
        assert len(sessions.list_for("alice")) == 1

    def test_rotation_does_not_grow_the_store(self):
        # ~96 refreshes per device per day at a 15-minute access token. A row
        # per token would make this file unbounded.
        tok = sessions.create("alice")
        for _ in range(20):
            tok, _ = sessions.rotate(tok)
        assert len(sessions._load()["sessions"]) == 1

    def test_rotating_an_unknown_token_returns_none(self):
        assert sessions.rotate("nope") is None


class TestReuseDetection:
    def test_a_superseded_token_outside_the_grace_window_is_reuse(self, monkeypatch):
        tok = sessions.create("alice")
        sessions.rotate(tok)
        # Age the rotation past the grace window.
        monkeypatch.setattr(sessions, "ROTATION_GRACE_SECONDS", -1)
        with pytest.raises(sessions.ReuseDetected):
            sessions.rotate(tok)

    def test_the_attack_this_is_for(self, monkeypatch):
        """A thief rotates the stolen token; the real client is next.

        Without detection the real user's refresh looks merely stale, they get
        signed out, and the thief — holding the live chain — continues
        indefinitely. The point is that this is NOT silent.
        """
        victim = sessions.create("alice")
        stolen = victim
        thief_token, _ = sessions.rotate(stolen)      # thief refreshes first
        assert sessions.get(thief_token) is not None

        monkeypatch.setattr(sessions, "ROTATION_GRACE_SECONDS", -1)
        with pytest.raises(sessions.ReuseDetected):
            sessions.rotate(victim)                    # the real client, now

    def test_two_tabs_refreshing_together_do_not_sign_the_user_out(self):
        # The opposite failure. Inside the grace window a repeated submit is
        # a double submit, not theft — a user with two tabs open, or a client
        # retrying after a response it never received.
        tok = sessions.create("alice")
        first, _ = sessions.rotate(tok)
        second, _ = sessions.rotate(tok)      # same token again, immediately
        # Answered with the token the first call already issued, so the two
        # tabs share one chain instead of forking it.
        assert second == first
        assert sessions.get(first) is not None

    def test_the_grace_window_hands_back_the_same_successor(self):
        tok = sessions.create("alice")
        first, _ = sessions.rotate(tok)
        again, _ = sessions.rotate(tok)
        assert again == first
        assert len(sessions._load()["sessions"]) == 1


class TestRevocation:
    def test_revoking_ends_the_session(self):
        tok = sessions.create("alice")
        assert sessions.revoke(tok) is True
        assert sessions.get(tok) is None

    def test_revoking_is_idempotent(self):
        tok = sessions.create("alice")
        sessions.revoke(tok)
        assert sessions.revoke(tok) is False

    def test_sign_out_everywhere_ends_every_session(self):
        for _ in range(3):
            sessions.create("alice")
        other = sessions.create("bob")
        assert sessions.revoke_all("alice") == 3
        assert sessions.list_for("alice") == []
        # Must not touch anyone else.
        assert sessions.get(other) is not None

    def test_sign_out_everywhere_is_case_insensitive_on_the_username(self):
        sessions.create("Alice")
        assert sessions.revoke_all("alice") == 1

    def test_one_user_cannot_revoke_another_users_session(self):
        # The session id travels to the browser, so this check is what stops a
        # guessed id reaching someone else's session.
        sessions.create("bob")
        bob_id = sessions.list_for("bob")[0]["id"]
        assert sessions.revoke_session("alice", bob_id) is False
        # And bob is still signed in.
        assert len(sessions.list_for("bob")) == 1

    def test_a_user_can_revoke_their_own_named_session(self):
        sessions.create("alice", user_agent="Firefox")
        sid = sessions.list_for("alice")[0]["id"]
        assert sessions.revoke_session("alice", sid) is True
        assert sessions.list_for("alice") == []


class TestExpiry:
    def test_an_expired_session_does_not_resolve(self, monkeypatch):
        monkeypatch.setattr(sessions, "REFRESH_TTL_SECONDS", -1)
        tok = sessions.create("alice")
        assert sessions.get(tok) is None

    def test_an_expired_session_cannot_be_rotated(self, monkeypatch):
        monkeypatch.setattr(sessions, "REFRESH_TTL_SECONDS", -1)
        tok = sessions.create("alice")
        assert sessions.rotate(tok) is None

    def test_expired_sessions_are_pruned(self, monkeypatch):
        monkeypatch.setattr(sessions, "REFRESH_TTL_SECONDS", -1)
        sessions.create("alice")
        monkeypatch.setattr(sessions, "REFRESH_TTL_SECONDS", 3600)
        sessions.create("bob")          # any write prunes
        assert len(sessions._load()["sessions"]) == 1

    def test_an_expired_session_is_not_listed(self, monkeypatch):
        monkeypatch.setattr(sessions, "REFRESH_TTL_SECONDS", -1)
        sessions.create("alice")
        assert sessions.list_for("alice") == []


class TestTheDeviceList:
    def test_it_reports_what_a_user_needs_to_recognise_a_device(self):
        sessions.create("alice", user_agent="Mozilla/5.0 Firefox", ip="203.0.113.9")
        row = sessions.list_for("alice")[0]
        assert row["user_agent"].startswith("Mozilla")
        assert row["ip"] == "203.0.113.9"
        assert row["last_used"] > 0

    def test_it_marks_the_current_session(self):
        mine = sessions.create("alice", user_agent="Firefox")
        sessions.create("alice", user_agent="Safari")
        rows = sessions.list_for("alice", current_token=mine)
        assert [r["current"] for r in rows].count(True) == 1
        assert next(r for r in rows if r["current"])["user_agent"] == "Firefox"

    def test_it_never_exposes_a_token_or_its_hash(self):
        tok = sessions.create("alice")
        rows = sessions.list_for("alice")
        blob = repr(rows)
        assert tok not in blob
        assert "hash" not in blob

    def test_the_user_agent_is_truncated(self):
        sessions.create("alice", user_agent="x" * 1000)
        assert len(sessions.list_for("alice")[0]["user_agent"]) <= 200

    def test_most_recently_used_first(self):
        a = sessions.create("alice", user_agent="old")
        time.sleep(0.01)
        sessions.create("alice", user_agent="new")
        time.sleep(0.01)
        sessions.rotate(a)              # touches 'old', making it newest
        assert sessions.list_for("alice")[0]["user_agent"] == "old"


class TestThePerUserCap:
    """Sessions must not accumulate without bound.

    Found by measurement, not by review: the e2e suite signs in once per test
    and left 335 live sessions on one account — which rendered 335 rows on the
    account screen and put a 335-entry linear scan on every token refresh. A
    real user reaches the same place more slowly; logging in daily from three
    devices for a month is ninety live refresh tokens, each one a usable
    credential long after the device was last touched.
    """

    def test_sessions_stop_accumulating(self):
        for _ in range(sessions.MAX_SESSIONS_PER_USER + 15):
            sessions.create("alice")
        assert len(sessions.list_for("alice")) == sessions.MAX_SESSIONS_PER_USER

    def test_the_least_recently_used_is_the_one_dropped(self):
        # Not the oldest-created: a session made months ago and used this
        # morning is someone's main machine.
        keep = sessions.create("alice", user_agent="daily-driver")
        for i in range(sessions.MAX_SESSIONS_PER_USER - 1):
            sessions.create("alice", user_agent=f"other-{i}")
        sessions.rotate(keep)          # touches it, making it most recent
        sessions.create("alice", user_agent="newcomer")

        agents = {r["user_agent"] for r in sessions.list_for("alice")}
        assert "daily-driver" in agents, "the actively used session was evicted"
        assert "newcomer" in agents

    def test_one_users_logins_do_not_evict_anothers(self):
        bob = sessions.create("bob")
        for _ in range(sessions.MAX_SESSIONS_PER_USER + 5):
            sessions.create("alice")
        assert sessions.get(bob) is not None

    def test_the_newest_session_always_survives(self):
        # Whatever else is dropped, the token just handed to the caller has to
        # work — otherwise logging in would sometimes log you straight out.
        for _ in range(sessions.MAX_SESSIONS_PER_USER + 3):
            tok = sessions.create("alice")
        assert sessions.get(tok) is not None
