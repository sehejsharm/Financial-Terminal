"""Crash-safe persistence.

These pin the failure that took the deployed backend down: a truncate-then-
write to users.json, interrupted by a full disk, left the file empty — every
account gone, login broken, and freeing the disk did not bring them back.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from lib.atomic import read_json_resilient, write_json_atomic


@pytest.fixture
def d(tmp_path):
    return tmp_path


def test_writes_and_reads_back(d):
    p = d / "x.json"
    write_json_atomic(p, {"a": 1})
    assert json.loads(p.read_text()) == {"a": 1}


def test_leaves_no_temp_files_behind(d):
    p = d / "x.json"
    for i in range(3):
        write_json_atomic(p, {"n": i})
    leftovers = [f.name for f in d.iterdir() if f.name.endswith(".tmp")]
    assert leftovers == []


def test_A_FAILED_WRITE_LEAVES_THE_OLD_FILE_INTACT(d, monkeypatch):
    """The whole point. Simulate ENOSPC part-way through the write."""
    p = d / "users.json"
    write_json_atomic(p, {"users": {"admin": {"hash": "abc"}}})
    good = p.read_text()

    real_dump = json.dump

    def boom(obj, fh, **kw):
        fh.write('{"users": {"adm')          # partial content, then die
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(json, "dump", boom)
    with pytest.raises(OSError):
        write_json_atomic(p, {"users": {"admin": {"hash": "xyz"}}})
    monkeypatch.setattr(json, "dump", real_dump)

    # Untouched — not truncated, not half-written.
    assert p.read_text() == good
    assert json.loads(p.read_text())["users"]["admin"]["hash"] == "abc"
    assert [f.name for f in d.iterdir() if f.name.endswith(".tmp")] == []


def test_keeps_a_backup_of_the_previous_contents(d):
    p = d / "x.json"
    write_json_atomic(p, {"v": 1})
    write_json_atomic(p, {"v": 2})
    assert json.loads(p.read_text()) == {"v": 2}
    assert json.loads((d / "x.json.bak").read_text()) == {"v": 1}


def test_recovers_from_the_backup_when_the_primary_is_corrupt(d):
    p = d / "x.json"
    write_json_atomic(p, {"v": 1})
    write_json_atomic(p, {"v": 2})
    p.write_text("{ this is not json")          # external mangling

    assert read_json_resilient(p, {}) == {"v": 1}
    # The unreadable file is quarantined, never silently overwritten.
    assert any(f.name.startswith("x.json.corrupt-") for f in d.iterdir())


def test_returns_the_default_when_both_copies_are_gone(d):
    assert read_json_resilient(d / "missing.json", {"users": {}}) == {"users": {}}


def test_an_empty_file_is_treated_as_corrupt_not_as_empty_data(d):
    p = d / "x.json"
    write_json_atomic(p, {"users": {"admin": 1}})
    write_json_atomic(p, {"users": {"admin": 2}})
    p.write_text("")                            # what a failed write used to leave

    got = read_json_resilient(p, {"users": {}})
    assert got == {"users": {"admin": 1}}, "should fall back to .bak, not report an empty DB"


# ── the real user store ───────────────────────────────────────────────────

def test_user_store_survives_a_failed_save(tmp_path, monkeypatch):
    import lib.auth as la
    monkeypatch.setattr(la, "DATA_DIR", tmp_path)
    monkeypatch.setattr(la, "USERS_PATH", tmp_path / "users.json")
    monkeypatch.setattr(la, "INITIAL_PW_PATH", tmp_path / "ipw.txt")

    la._save({"users": {"admin": {"salt": "s", "hash": "h", "active": True,
                                  "role": la.ROLE_MASTER, "display": "admin"}}})
    assert "admin" in la._load()["users"]

    def boom(obj, fh, **kw):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(json, "dump", boom)
    with pytest.raises(OSError):
        la._save({"users": {}})
    monkeypatch.undo()

    # Re-point after undo(), then confirm the account is still there.
    monkeypatch.setattr(la, "DATA_DIR", tmp_path)
    monkeypatch.setattr(la, "USERS_PATH", tmp_path / "users.json")
    assert "admin" in la._load()["users"], "a failed save must not lose accounts"


def test_storage_docs_survive_a_failed_save(tmp_path, monkeypatch):
    from backend import storage as st
    store = st.JSONStore(tmp_path)
    store.save_user_doc("portfolios", "admin", {"portfolios": [{"id": "p1"}]})
    assert store.user_doc("portfolios", "admin")["portfolios"][0]["id"] == "p1"

    def boom(obj, fh, **kw):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(json, "dump", boom)
    with pytest.raises(OSError):
        store.save_user_doc("portfolios", "admin", {"portfolios": []})
    monkeypatch.undo()

    assert store.user_doc("portfolios", "admin")["portfolios"][0]["id"] == "p1"


def test_watchlists_survive_a_failed_save(tmp_path, monkeypatch):
    from backend import storage as st
    store = st.JSONStore(tmp_path)
    store.upsert_watchlist("admin", {"id": "w1", "name": "Energy", "tickers": ["ONGC.NS"]})
    assert store.watchlists_for("admin")[0]["name"] == "Energy"

    def boom(obj, fh, **kw):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(json, "dump", boom)
    with pytest.raises(OSError):
        store.upsert_watchlist("admin", {"id": "w2", "name": "X", "tickers": []})
    monkeypatch.undo()

    assert store.watchlists_for("admin")[0]["name"] == "Energy"
