"""Coalesced market-data poller.

One asyncio task for the whole server. Each symbol is polled at a cadence set
by its market's session state (NSE ~1.5 s when open, US ~8 s to respect the
Twelve Data free ceiling, 60 s when closed). Blocking provider calls run in a
worker thread so the event loop stays free for the WebSocket fan-out.

This is the *free-poller* ingest adapter. A broker-WebSocket adapter can
replace it later without any change to the hub, the wire contract, or the
client — it just needs to call hub.publish(sym, tick).
"""
from __future__ import annotations

import asyncio
import logging
import time

from backend import providers
from backend.stream import hub, session

log = logging.getLogger("motherboard.stream.ingest")

_BASE_TICK = 0.25          # loop wake interval (s)
_MAX_BATCH = 60            # cap symbols polled per pass (VM + rate-limit guard)

_next_due: dict[str, float] = {}
_metrics = {"last_poll_ms": 0.0, "last_batch": 0, "polls": 0, "feed_latency_ms": 0.0}


def _to_tick(sym: str, q: dict | None) -> dict | None:
    if not q or q.get("price") is None:
        return None
    price = float(q["price"])
    prev = q.get("prev_close")
    chg = (price - float(prev)) if prev is not None else q.get("change")
    return {
        "s": sym,
        "ltp": price,
        "chg": round(chg, 4) if chg is not None else None,
        "chgPct": q.get("change_pct"),
        "bid": q.get("bid"),
        "ask": q.get("ask"),
        "vol": q.get("volume") or q.get("vol"),
        "ccy": q.get("currency"),
        "src": q.get("src") or ("nse" if session.market_for_symbol(sym) == "NSE" else "td"),
        "stale": not session.is_open(session.market_for_symbol(sym)),
        "ts": int(time.time() * 1000),
    }


def _due(symbols: list[str], now: float) -> list[str]:
    out = []
    for sym in symbols:
        if now >= _next_due.get(sym, 0):
            out.append(sym)
    return out[:_MAX_BATCH]


async def _poll_once() -> None:
    active = hub.active_symbols()
    if not active:
        return
    now = time.monotonic()
    due = _due(active, now)
    if not due:
        return
    t0 = time.perf_counter()
    quotes = await asyncio.to_thread(providers.quotes_bulk, due)
    _metrics["feed_latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    for sym in due:
        tick = _to_tick(sym, quotes.get(sym))
        cad = session.cadence_ms(session.market_for_symbol(sym)) / 1000.0
        _next_due[sym] = now + cad
        if tick:
            hub.publish(sym, tick)
    _metrics["last_batch"] = len(due)
    _metrics["polls"] += 1
    # Drop schedule entries for symbols nobody wants anymore.
    if len(_next_due) > 4 * _MAX_BATCH:
        for sym in list(_next_due):
            if sym not in active:
                _next_due.pop(sym, None)


async def run() -> None:
    log.info("stream ingest loop started")
    while True:
        t0 = time.perf_counter()
        try:
            await _poll_once()
        except Exception:
            log.exception("ingest poll failed")
        _metrics["last_poll_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        await asyncio.sleep(_BASE_TICK)


def metrics() -> dict:
    return dict(_metrics)
