"""In-process async pub/sub hub for market ticks.

Single uvicorn worker → single event loop, so no cross-process fan-out is
needed: connections register here, the ingest loop publishes deltas, and the
hub pushes only-changed fields to the connections subscribed to each symbol.
The union of all subscribed symbols (ref-counted) is what the ingest loop
polls — one request per symbol per interval no matter how many clients want
it.

Redis (already deployed, 48 MB LRU) mirrors the last tick per symbol so a
reconnecting client gets an instant snapshot even across a backend restart.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from backend import dataplane, feeds
from backend.stream import delayed

log = logging.getLogger("motherboard.stream.hub")

# Numeric fields we diff/emit. Order irrelevant; s + ts are always attached.
_FIELDS = ("ltp", "chg", "chgPct", "bid", "ask", "vol")
_QUEUE_MAX = 256  # per-connection backlog before we coalesce-drop oldest

_conns: set["Connection"] = set()
_refcount: dict[str, int] = {}
_last: dict[str, dict] = {}

# Dedicated Redis client with TIGHT socket timeouts. The last-tick mirror is
# touched from publish()/add_symbols(), which run on the asyncio event loop —
# a hung Redis node must fail in ~250 ms instead of stalling every streaming
# client. (The shared cache client has no such bound, so we don't reuse it.)
_redis = None
try:
    from backend.config import REDIS_URL
    if REDIS_URL:
        import redis  # type: ignore
        _redis = redis.Redis.from_url(
            REDIS_URL, decode_responses=False,
            socket_timeout=0.25, socket_connect_timeout=0.25,
        )
except Exception:  # pragma: no cover
    _redis = None

_REDIS_TTL = 24 * 3600


class Connection:
    """One client (WebSocket or SSE). Owns a queue the send-loop drains."""

    __slots__ = ("queue", "symbols", "alive", "tier")

    def __init__(self, tier: str = dataplane.REALTIME) -> None:
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=_QUEUE_MAX)
        self.symbols: set[str] = set()
        self.alive = True
        # Which data plane this client is entitled to. Set from the plan in
        # the token when the socket authenticates (see routes/stream.py).
        #
        # Defaults to REALTIME because the only data this app has ever served
        # is PUBLIC, and public data is not withheld from anyone — see
        # backend/dataplane. The default is therefore "no restriction", and it
        # is `publish` that decides, from the SOURCE of each tick, whether
        # this tier may see it. A default of DELAYED would instead have meant
        # every existing client silently stopped receiving prices.
        self.tier = tier

    def _enqueue(self, frame: dict) -> None:
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            # Slow client: don't drop individual deltas (that would silently
            # lose a field that only changed once). Collapse the whole backlog
            # into ONE fresh snapshot of this connection's symbols from _last,
            # so the client resyncs to a complete, current state.
            try:
                while True:
                    self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            snap = [_last[s] for s in self.symbols if s in _last]
            try:
                self.queue.put_nowait({"t": "snap", "d": snap})
            except asyncio.QueueFull:
                pass


def register(conn: Connection) -> None:
    _conns.add(conn)


def unregister(conn: Connection) -> None:
    conn.alive = False
    _conns.discard(conn)
    for sym in list(conn.symbols):
        _decref(sym)
    conn.symbols.clear()


def _incref(sym: str) -> None:
    _refcount[sym] = _refcount.get(sym, 0) + 1


def _decref(sym: str) -> None:
    n = _refcount.get(sym, 0) - 1
    if n <= 0:
        _refcount.pop(sym, None)
        # Evict the in-memory last-tick too, so _last doesn't grow unbounded
        # with the universe of symbols ever seen. Redis re-warms it on a later
        # re-subscribe.
        _last.pop(sym, None)
        # And the delayed history, which is far larger per symbol than _last
        # (a whole delay window of ticks rather than one).
        delayed.forget(sym)
    else:
        _refcount[sym] = n


def add_symbols(conn: Connection, symbols: list[str]) -> list[dict]:
    """Subscribe a connection to symbols; return immediate snapshot frames
    (from memory or Redis) so the client paints without waiting for a tick."""
    snap: list[dict] = []
    for raw in symbols:
        sym = raw.strip().upper()
        if not sym or sym in conn.symbols:
            continue
        conn.symbols.add(sym)
        _incref(sym)
        tick = _last.get(sym) or _load_redis(sym)
        if tick:
            snap.append(tick)
    return snap


def remove_symbols(conn: Connection, symbols: list[str]) -> None:
    for raw in symbols:
        sym = raw.strip().upper()
        if sym in conn.symbols:
            conn.symbols.discard(sym)
            _decref(sym)


def active_symbols() -> list[str]:
    """The union set the ingest loop must poll."""
    return list(_refcount.keys())


def publish(sym: str, tick: dict) -> None:
    """Diff `tick` against the last value; push only-changed fields to every
    connection subscribed to `sym`. `tick` carries full fields; we persist the
    full value but transmit a delta."""
    sym = sym.upper()
    prev = _last.get(sym)
    changed: dict[str, Any] = {}
    for f in _FIELDS:
        v = tick.get(f)
        pv = prev.get(f) if prev else None
        if v is None and pv is not None:
            changed[f] = None          # explicit clear — a field went away
        elif v is not None and pv != v:
            changed[f] = v
    # Static-ish metadata only sent when it (re)appears.
    for f in ("ccy", "src", "stale"):
        v = tick.get(f)
        if v is not None and (prev is None or prev.get(f) != v):
            changed[f] = v

    full = {"s": sym, "ts": tick.get("ts") or int(time.time() * 1000)}
    full.update({f: tick.get(f) for f in (*_FIELDS, "ccy", "src", "stale")
                 if tick.get(f) is not None})
    _last[sym] = full
    _save_redis(sym, full)

    if not changed:
        return  # nothing moved — emit nothing (bandwidth + no false flash)
    frame = {"t": "px", "d": [{"s": sym, "ts": full["ts"], **changed}]}

    # A licensed tick must never reach a subscriber who is not entitled to it.
    # This is a contract term, not a product preference: a free account seeing
    # live licensed prices is a breach, and the kind that surfaces in an audit
    # of logs months later.
    #
    # Checked here, at the single point every tick passes through, rather than
    # at each route — there is one publish() and there are several ways to
    # subscribe, so this is the only place the rule cannot be forgotten.
    source_class = tick.get("source_class") or dataplane.PUBLIC
    if source_class == dataplane.LICENSED:
        delayed.record(sym, full, _as_of_seconds(full))

    for conn in _conns:
        if not (conn.alive and sym in conn.symbols):
            continue
        if dataplane.requires_delay(source_class, conn.tier):
            # Deliberately sends nothing now. The delayed plane serves this
            # client from history on its own cadence; pushing the live frame
            # "just this once" is exactly the leak being prevented.
            continue
        conn._enqueue(frame)


def _as_of_seconds(full: dict) -> float:
    """The feed's own timestamp, in seconds.

    Falls back to the local clock only if a tick arrived without one. That
    fallback can only make the delay LONGER than promised (the local clock is
    at or after the feed's), never shorter, which is the one direction that
    would breach a licence.
    """
    ts = full.get("ts")
    return (ts / 1000.0) if isinstance(ts, (int, float)) else time.time()


def publish_delayed(sym: str, now: float | None = None) -> int:
    """Push the released delayed value to subscribers on the delayed plane.

    Called on a slow cadence by the ingest loop. Returns how many connections
    were served, which is what makes it observable in /stream/health.
    """
    sym = sym.upper()
    tick = delayed.released(sym, now if now is not None else time.time())
    if tick is None:
        return 0
    frame = {"t": "px", "d": [dict(tick)]}
    served = 0
    for conn in _conns:
        if (conn.alive and sym in conn.symbols
                and conn.tier != dataplane.REALTIME):
            conn._enqueue(frame)
            served += 1
    return served


def last_tick(sym: str) -> dict | None:
    return _last.get(sym.upper())


def stats() -> dict:
    """Observability: what the /admin health panel reads."""
    return {
        "connections": len(_conns),
        "symbols": len(_refcount),
        "cached": len(_last),
        "backlog_max": max((c.queue.qsize() for c in _conns), default=0),
        # Split by plane, so it is visible at a glance whether the delayed
        # path is actually serving anybody — a licensing control that silently
        # serves nobody looks identical to one that works.
        "realtimeConnections": sum(1 for c in _conns
                                   if c.tier == dataplane.REALTIME),
        "delayedConnections": sum(1 for c in _conns
                                  if c.tier != dataplane.REALTIME),
        "licensedFeed": (feeds.active().name if feeds.active() else None),
        **delayed.stats(),
    }


# ── Redis last-tick mirror (best-effort) ──────────────────────────────────

def _save_redis(sym: str, tick: dict) -> None:
    if _redis is None:
        return
    try:
        _redis.setex(f"stream:last:{sym}", _REDIS_TTL, json.dumps(tick))
    except Exception:
        pass


def _load_redis(sym: str) -> dict | None:
    if _redis is None:
        return None
    try:
        raw = _redis.get(f"stream:last:{sym}")
        if raw:
            tick = json.loads(raw)
            _last[sym] = tick  # warm memory
            return tick
    except Exception:
        pass
    return None
