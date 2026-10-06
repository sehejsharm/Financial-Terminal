"""The delayed plane: licensed ticks held back until they are old enough.

Only used when a licensed feed is active. Public data goes straight through —
see backend/dataplane for why that is the right way round.

HOW IT WORKS

Every licensed tick is appended to a per-symbol history with the FEED's own
timestamp. A free subscriber is served the newest tick whose timestamp is at
least DELAY_SECONDS old. That is the whole mechanism, and it has one property
worth naming: the delay is measured against the feed's clock, not ours, so a
slow poll or a local clock drift can only ever make the delay longer than
promised, never shorter. Shorter would be the licence breach.

WHY A HISTORY AND NOT A TIMER

The obvious implementation is to publish each tick on a fifteen-minute timer.
That fails in two ways this does not: a client connecting now would see nothing
at all for fifteen minutes (rather than immediately seeing the price as it was
fifteen minutes ago, which is what a delayed quote means), and every held tick
would need a scheduled task, so a thousand symbols would mean a thousand
pending callbacks. Keeping a short history and reading backwards from it is
both cheaper and the correct semantics.

Memory is bounded by pruning anything older than the delay window plus a small
margin, so the history holds roughly one delay window per subscribed symbol.
"""
from __future__ import annotations

import threading
from collections import defaultdict, deque
from typing import Any, Deque

from backend.dataplane import DELAY_SECONDS

# Keep a little more than the window itself, so the newest-older-than-cutoff
# lookup always has something to find right after a prune.
_MARGIN_SECONDS = 120

# Hard cap per symbol, so a pathologically chatty feed cannot grow this
# without bound between prunes. At one tick per second a 15-minute window is
# ~900 entries; 4000 is generous headroom and still small.
_MAX_PER_SYMBOL = 4000

_lock = threading.Lock()
_history: dict[str, Deque[tuple[float, dict[str, Any]]]] = defaultdict(deque)


def record(symbol: str, tick: dict[str, Any], as_of: float) -> None:
    """Remember a licensed tick, keyed by the FEED's timestamp.

    `as_of` must come from the feed. Substituting the local clock would
    shorten the effective delay by however long the tick took to reach us,
    which is the one direction this must never err in.
    """
    sym = symbol.upper()
    with _lock:
        hist = _history[sym]
        # Out-of-order arrivals are normal on a reconnect. Appending anyway
        # keeps this O(1); `released` scans for the newest qualifying entry
        # rather than assuming the tail is the newest.
        hist.append((as_of, tick))
        cutoff = as_of - (DELAY_SECONDS + _MARGIN_SECONDS)
        while hist and hist[0][0] < cutoff:
            hist.popleft()
        while len(hist) > _MAX_PER_SYMBOL:
            hist.popleft()


def released(symbol: str, now: float) -> dict[str, Any] | None:
    """The newest tick old enough to show a delayed subscriber, or None."""
    sym = symbol.upper()
    cutoff = now - DELAY_SECONDS
    with _lock:
        hist = _history.get(sym)
        if not hist:
            return None
        best: tuple[float, dict[str, Any]] | None = None
        for stamp, tick in hist:
            if stamp <= cutoff and (best is None or stamp > best[0]):
                best = (stamp, tick)
        return dict(best[1]) if best else None


def forget(symbol: str) -> None:
    """Drop a symbol's history when nothing is subscribed to it any more."""
    with _lock:
        _history.pop(symbol.upper(), None)


def stats() -> dict:
    with _lock:
        return {"delayedSymbols": len(_history),
                "delayedTicksHeld": sum(len(h) for h in _history.values())}


def clear() -> None:
    """Test helper."""
    with _lock:
        _history.clear()
