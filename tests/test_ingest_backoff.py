"""Stream ingest: backing off symbols the feed cannot price.

This is a performance fix with a correctness contract. The free tier can't
price a large slice of the catalogue from a cloud host, and every attempt at
one still costs a full provider round trip that ends in a timeout. Retrying
those forever saturates the thread pool on a 1-vCPU VM, and because the
blocking work holds the GIL it starves the event loop — the whole API slows
down, not just the stream.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.stream import ingest


@pytest.fixture(autouse=True)
def clean_state():
    ingest._next_due.clear()
    ingest._misses.clear()
    yield
    ingest._next_due.clear()
    ingest._misses.clear()


# ── the backoff curve ─────────────────────────────────────────────────────

def test_a_working_symbol_polls_at_its_normal_cadence():
    for misses in range(0, ingest._BACKOFF_AFTER + 1):
        assert ingest.next_delay_ms(8000, misses) == 8000


def test_the_first_few_misses_are_free():
    # A single timeout is a blip, not an outage — don't punish it.
    assert ingest.next_delay_ms(1500, 1) == 1500
    assert ingest.next_delay_ms(1500, ingest._BACKOFF_AFTER) == 1500


def test_delay_doubles_once_past_the_grace_window():
    base = 8000
    a = ingest.next_delay_ms(base, ingest._BACKOFF_AFTER + 1)
    b = ingest.next_delay_ms(base, ingest._BACKOFF_AFTER + 2)
    assert a == base * 2
    assert b == a * 2


def test_backoff_is_monotonic_and_capped():
    prev = 0
    for n in range(0, 60):
        d = ingest.next_delay_ms(8000, n)
        assert d >= prev, "backoff must never shrink as misses accumulate"
        assert d <= ingest._MAX_BACKOFF_MS
        prev = d
    # And it really does reach the ceiling rather than growing unbounded.
    assert ingest.next_delay_ms(8000, 60) == ingest._MAX_BACKOFF_MS


def test_a_huge_miss_count_cannot_overflow():
    assert ingest.next_delay_ms(8000, 10_000) == ingest._MAX_BACKOFF_MS


# ── the poll loop ─────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


def _patch(monkeypatch, active, quotes):
    monkeypatch.setattr(ingest.hub, "active_symbols", lambda: list(active))
    monkeypatch.setattr(ingest.providers, "quotes_bulk", lambda syms: {
        s: quotes.get(s) for s in syms})
    published: list[str] = []
    monkeypatch.setattr(ingest.hub, "publish", lambda s, t: published.append(s))
    return published


def test_an_unpriceable_symbol_accumulates_misses_and_is_deferred(monkeypatch):
    _patch(monkeypatch, ["DEAD"], {"DEAD": None})

    for _ in range(6):
        # Force it due each time so we can watch the counter climb.
        ingest._next_due["DEAD"] = 0
        _run(ingest._poll_once())

    assert ingest._misses["DEAD"] == 6
    # It is now scheduled well into the future rather than immediately.
    assert ingest._next_due["DEAD"] > 0


def test_a_priced_symbol_never_accumulates_misses(monkeypatch):
    pub = _patch(monkeypatch, ["LIVE"], {"LIVE": {"price": 101.5, "prev_close": 100}})

    for _ in range(4):
        ingest._next_due["LIVE"] = 0
        _run(ingest._poll_once())

    assert "LIVE" not in ingest._misses
    assert pub == ["LIVE"] * 4


def test_RECOVERY_resets_the_backoff_immediately(monkeypatch):
    """A symbol that starts working again must go straight back to full
    speed — not stay throttled because it was broken ten minutes ago."""
    quotes: dict = {"FLAKY": None}
    pub = _patch(monkeypatch, ["FLAKY"], quotes)

    for _ in range(8):
        ingest._next_due["FLAKY"] = 0
        _run(ingest._poll_once())
    assert ingest._misses["FLAKY"] == 8

    quotes["FLAKY"] = {"price": 42.0, "prev_close": 41.0}
    ingest._next_due["FLAKY"] = 0
    _run(ingest._poll_once())

    assert "FLAKY" not in ingest._misses
    assert pub == ["FLAKY"]


def test_a_dead_symbol_does_not_delay_a_live_one(monkeypatch):
    """The whole point: one broken symbol must not slow down the others."""
    pub = _patch(monkeypatch, ["DEAD", "LIVE"], {
        "DEAD": None, "LIVE": {"price": 10.0, "prev_close": 9.0}})

    for _ in range(6):
        ingest._next_due["DEAD"] = 0
        ingest._next_due["LIVE"] = 0
        _run(ingest._poll_once())

    assert pub == ["LIVE"] * 6
    assert ingest._misses["DEAD"] == 6
    # LIVE stays on its normal schedule; DEAD is pushed much further out.
    assert ingest._next_due["DEAD"] > ingest._next_due["LIVE"]


def test_dropping_a_symbol_clears_its_miss_counter(monkeypatch):
    _patch(monkeypatch, ["GONE"], {"GONE": None})
    ingest._next_due["GONE"] = 0
    _run(ingest._poll_once())
    assert "GONE" in ingest._misses

    # Nobody is subscribed any more, and the schedule is large enough to
    # trigger the sweep.
    monkeypatch.setattr(ingest.hub, "active_symbols", lambda: ["OTHER"])
    monkeypatch.setattr(ingest.providers, "quotes_bulk", lambda syms: {s: None for s in syms})
    for i in range(4 * ingest._MAX_BATCH + 2):
        ingest._next_due[f"filler{i}"] = 0
    ingest._next_due["OTHER"] = 0
    _run(ingest._poll_once())

    assert "GONE" not in ingest._misses
    assert "GONE" not in ingest._next_due


def test_metrics_report_how_many_symbols_are_backed_off(monkeypatch):
    _patch(monkeypatch, ["A", "B"], {"A": None, "B": {"price": 1.0}})
    for _ in range(ingest._BACKOFF_AFTER + 2):
        ingest._next_due["A"] = 0
        ingest._next_due["B"] = 0
        _run(ingest._poll_once())
    assert ingest.metrics()["backed_off"] == 1


def test_the_batch_is_capped_so_one_pass_cannot_run_away(monkeypatch):
    many = [f"S{i}" for i in range(500)]
    _patch(monkeypatch, many, {})
    _run(ingest._poll_once())
    assert ingest.metrics()["last_batch"] <= ingest._MAX_BATCH
