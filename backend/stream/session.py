"""Market-session logic — decides poll cadence and honest LIVE/CLOSED state.

We only stream when a market is actually trading; off-hours we idle-poll
slowly (to catch official-close corrections) and the badge reads CLOSED, so
we never fake ticks the exchange isn't producing.
"""
from __future__ import annotations

from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

_IST = ZoneInfo("Asia/Kolkata")
_ET = ZoneInfo("America/New_York")

# (open, close) local trading hours, regular session.
_NSE_OPEN, _NSE_CLOSE = time(9, 15), time(15, 30)
_US_OPEN, _US_CLOSE = time(9, 30), time(16, 0)

# Poll cadence per market state (ms). Open = near-real-time; closed = a slow
# heartbeat so reconnecting clients still get the last close.
CADENCE_OPEN_MS = 1500      # NSE hot path (VM sits ~ms from NSE)
CADENCE_OPEN_US_MS = 8000   # US via Twelve Data free (8 req/min ceiling)
CADENCE_CLOSED_MS = 60000


def market_for_symbol(sym: str) -> str:
    """'NSE' for Indian listings/indices, else 'US' (the free-tier default
    bucket for everything non-Indian)."""
    s = sym.upper()
    if s.endswith(".NS") or s.endswith(".BO"):
        return "NSE"
    # NSE indices are the ^CNX*/^NSE*/^BSE*/^INDIAVIX family.
    if s.startswith("^") and any(
        tok in s for tok in ("NSE", "BSE", "CNX", "NIFTY", "INDIAVIX", "CRSLDX")
    ):
        return "NSE"
    return "US"


def _is_open(local_now: datetime, open_t: time, close_t: time) -> bool:
    if local_now.weekday() >= 5:  # Sat/Sun
        return False
    return open_t <= local_now.timetz().replace(tzinfo=None) <= close_t


def is_open(market: str, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    if market == "NSE":
        return _is_open(now.astimezone(_IST), _NSE_OPEN, _NSE_CLOSE)
    return _is_open(now.astimezone(_ET), _US_OPEN, _US_CLOSE)


def cadence_ms(market: str, now: datetime | None = None) -> int:
    """Milliseconds between polls for one symbol given its market state."""
    if not is_open(market, now):
        return CADENCE_CLOSED_MS
    return CADENCE_OPEN_MS if market == "NSE" else CADENCE_OPEN_US_MS


def any_market_open(now: datetime | None = None) -> bool:
    return is_open("NSE", now) or is_open("US", now)


def session_state(sym: str, now: datetime | None = None) -> dict:
    """Per-symbol session descriptor for the client's honesty badge."""
    market = market_for_symbol(sym)
    open_ = is_open(market, now)
    return {"market": market, "open": open_, "cadenceMs": cadence_ms(market, now)}
