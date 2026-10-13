"""The user store must not lose writes when two requests overlap.

lib/auth.py keeps users.json as a whole-file document: _load() reads it, the
caller mutates the dict, _save() writes it all back. That is a read-modify-write
cycle, and Starlette runs sync endpoints in a threadpool, so two requests really
can interleave:

    A: _load()  ->  B: _load()  ->  A: _save()  ->  B: _save()

B wrote a copy of the file it read BEFORE A's change existed, so A's change is
gone. The user-visible shape of that is an account that the admin screen said
was created, or a plan the admin screen said was changed, quietly reverting.

HOW THESE TESTS GET A DETERMINISTIC ANSWER: a real race is microseconds wide, so
hoping to hit it would make this suite flake in both directions. Instead each
test widens the window on purpose — `_widen_read_write_window` makes every
_load() sleep after it reads — and then asserts on the OUTCOME, not on timing.
The sleep changes only how long the gap is, never who may write during it:

  * with a lock held across load-mutate-save, the sleep sits INSIDE the critical
    section, the threads run one after another, and every write survives;
  * with no lock, all the threads read the same snapshot during the sleep and
    then overwrite each other, every time.

So these tests pass or fail on whether the cycle is serialized, which is the
property under test.

Deliberately NOT tested here: two processes. A threading lock protects one
process only; see the comment on lib.auth._lock.
"""
from __future__ import annotations

import threading
import time

import lib.auth as auth

# Long enough to swamp thread start-up jitter (microseconds), short enough that
# the whole module stays under a couple of seconds.
_WIDEN_SECONDS = 0.05


def _isolate(monkeypatch, tmp_path):
    """Point the store at a scratch directory, never the real data/."""
    monkeypatch.setattr(auth, "DATA_DIR", tmp_path)
    monkeypatch.setattr(auth, "USERS_PATH", tmp_path / "users.json")
    monkeypatch.setattr(auth, "INITIAL_PW_PATH", tmp_path / "INITIAL.txt")
    # A fixed admin password keeps _seed() deterministic and stops it printing a
    # generated one to stderr on every test.
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "admin")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", "seed-password-xyz")


def _widen_read_write_window(monkeypatch):
    """Stretch the gap between the read and the write of every cycle."""
    real_load = auth._load

    def slow_load():
        data = real_load()
        time.sleep(_WIDEN_SECONDS)
        return data

    monkeypatch.setattr(auth, "_load", slow_load)


def _run_together(fns):
    """Run callables on their own threads, then re-raise anything they raised."""
    errors: list[BaseException] = []
    guard = threading.Lock()

    def wrap(fn):
        def go():
            try:
                fn()
            except BaseException as exc:  # pragma: no cover - diagnostic only
                with guard:
                    errors.append(exc)
        return go

    threads = [threading.Thread(target=wrap(fn)) for fn in fns]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not any(t.is_alive() for t in threads), "a worker thread never finished"
    if errors:
        raise errors[0]


def _stored_usernames() -> set[str]:
    return {u["username"] for u in auth.list_users()}


def test_concurrent_create_user_keeps_every_account(monkeypatch, tmp_path):
    """Eight accounts created at once: all eight must still be there.

    This is the data-loss bug in its plainest form. Every call returns
    "created", so nothing upstream has any reason to retry, and yet without
    serialization only the last writer's account is in the file.
    """
    _isolate(monkeypatch, tmp_path)
    # Seed up front so the file exists before the threads start - otherwise this
    # test would also be exercising the first-run seed race, which has its own
    # test below.
    auth._save(auth._seed())
    _widen_read_write_window(monkeypatch)

    names = [f"trader{i}" for i in range(8)]
    reported: dict[str, tuple[bool, str]] = {}

    def creator(name):
        def go():
            reported[name] = auth.create_user(name, "password-123")
        return go

    _run_together([creator(n) for n in names])

    claimed = sorted(n for n, (ok, _) in reported.items() if ok)
    stored = _stored_usernames()
    lost = [n for n in claimed if n not in stored]
    assert not lost, (
        f"{len(lost)} of {len(claimed)} accounts were reported created and then "
        f"lost: {lost}"
    )


def test_concurrent_set_plan_keeps_every_change(monkeypatch, tmp_path):
    """Plan changes on different accounts must not erase each other.

    Worse than the create case in practice: the losing account keeps billing
    rights it was moved off, or loses rights it was moved onto, and nothing
    anywhere reports a failure.
    """
    _isolate(monkeypatch, tmp_path)
    auth._save(auth._seed())
    wanted = {"alice": "pro", "bob": "elite", "carol": "free",
              "dan": "pro", "erin": "elite"}
    for name in wanted:
        ok, msg = auth.create_user(name, "password-123")
        assert ok, msg
    _widen_read_write_window(monkeypatch)

    def mover(name, plan):
        def go():
            ok, msg = auth.set_plan(name, plan)
            assert ok, msg
        return go

    _run_together([mover(n, p) for n, p in wanted.items()])

    got = {u["username"]: u["plan"] for u in auth.list_users()}
    reverted = {n: (p, got.get(n)) for n, p in wanted.items() if got.get(n) != p}
    assert not reverted, (
        f"{len(reverted)} of {len(wanted)} plan changes were reported applied "
        f"and then reverted (wanted, got): {reverted}"
    )


def test_concurrent_create_and_delete_do_not_undo_each_other(monkeypatch, tmp_path):
    """A delete and an unrelated create at the same moment.

    Whichever of the two writes last wins the whole file, so the failure is one
    of: the deleted account comes back (an offboarded user keeps access), or the
    new account vanishes.
    """
    _isolate(monkeypatch, tmp_path)
    auth._save(auth._seed())
    ok, msg = auth.create_user("doomed", "password-123")
    assert ok, msg
    _widen_read_write_window(monkeypatch)

    _run_together([
        lambda: auth.delete_user("doomed"),
        lambda: auth.create_user("fresh", "password-123"),
    ])

    stored = _stored_usernames()
    assert "doomed" not in stored, "the deleted account was resurrected"
    assert "fresh" in stored, "the new account was lost"


def test_duplicate_username_is_only_created_once(monkeypatch, tmp_path):
    """Two creates of the SAME name: one must be refused, not silently clobbered.

    create_user checks "does this name exist" and then writes. Split those two
    steps across threads and both checks pass, both callers are told the account
    was created, and one of the two passwords is overwritten - so one admin
    hands out a password that does not work and has nothing to look at that says
    why. The check and the write have to be in one critical section.
    """
    _isolate(monkeypatch, tmp_path)
    auth._save(auth._seed())
    _widen_read_write_window(monkeypatch)

    passwords = ["password-aaa", "password-bbb"]
    reported: dict[str, tuple[bool, str]] = {}

    def creator(pw):
        def go():
            reported[pw] = auth.create_user("dup", pw)
        return go

    _run_together([creator(pw) for pw in passwords])

    accepted = [pw for pw, (ok, _) in reported.items() if ok]
    assert len(accepted) == 1, (
        f"{len(accepted)} callers were told 'dup' was created for them; exactly "
        f"one should have been, the other refused as a duplicate. Got: {reported}"
    )
    # The password the surviving caller was told would work must actually work.
    assert auth.verify_credentials("dup", accepted[0]) is not None


def test_first_run_seeds_exactly_once(monkeypatch, tmp_path):
    """_load() writes too, on first run, and that write races as well.

    _load() seeds the master admin when users.json is absent. Concurrent first
    requests each see "absent" and each seed a fresh account with its own salt
    and hash, one overwriting the next. With a generated password (no
    MOTHERBOARD_ADMIN_PASSWORD set) that is an operator lockout: the password
    surfaced in INITIAL_ADMIN_PASSWORD.txt belongs to whichever seed wrote the
    file last, which need not be the record that survived in users.json.
    """
    _isolate(monkeypatch, tmp_path)
    assert not auth.USERS_PATH.exists()

    real_seed = auth._seed
    tally = {"n": 0}
    guard = threading.Lock()

    def counting_seed():
        with guard:
            tally["n"] += 1
        data = real_seed()
        # Sleep BEFORE returning, i.e. before _load() saves: that is the window
        # in which another thread can also find the file missing.
        time.sleep(_WIDEN_SECONDS)
        return data

    monkeypatch.setattr(auth, "_seed", counting_seed)

    # list_users() is a plain read, which is the point: a read path that writes.
    _run_together([auth.list_users for _ in range(6)])

    assert tally["n"] == 1, (
        f"the first-run admin was seeded {tally['n']} times; every seed after "
        f"the first overwrites the one before it"
    )
    assert len(auth.list_users()) == 1
    assert auth.verify_credentials("admin", "seed-password-xyz") is not None
