"""Can a position of this size actually be traded?

A supply-chain screen that only tells you who supplies whom answers a
research question. A screen you would put nine figures through has to answer
an execution question too: if this analysis says buy the assembler and short
the display maker, how many days does each leg take to build, and which of
these names cannot absorb the size at all?

That is arithmetic over average daily value traded, and it is the single
most useful number this app was missing. Everything here is derived from the
same daily bars the charts already use — no new provider, no new key.

Deliberately conservative in the same direction throughout: participation
caps are on the low side, thin names are called untradable rather than given
an optimistic day count, and a symbol with no volume history returns nothing
instead of a default.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from statistics import median

#: Sessions used for the average. Twenty is roughly a month of trading —
#: long enough to smooth a single event day, short enough to reflect a
#: security whose liquidity has genuinely changed.
WINDOW = 20

#: Share of a day's volume a single participant can take without moving the
#: price against themselves. Desks argue about this; 15% is a common upper
#: bound for a patient order and is the default here. Anything above 25%
#: stops being "participating in the volume" and becomes "being the volume".
DEFAULT_PARTICIPATION = 0.15

#: Beyond this, calling something a number of days is false precision — the
#: honest answer is that the position cannot be built without becoming the
#: market in that name.
MAX_SENSIBLE_DAYS = 60


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None          # drop NaN


def _closes_volumes(candles: list[dict]) -> tuple[list[float], list[float]]:
    closes: list[float] = []
    vols: list[float] = []
    for c in candles or []:
        if not isinstance(c, dict):
            continue
        close = _num(c.get("close") if "close" in c else c.get("Close"))
        vol = _num(c.get("volume") if "volume" in c else c.get("Volume"))
        if close is None or vol is None:
            continue
        closes.append(close)
        vols.append(vol)
    return closes, vols


def adv(candles: list[dict], window: int = WINDOW) -> dict:
    """Average daily VALUE traded, from the last `window` sessions.

    Value, not share count: 10 million shares of a ₹12 stock and 10 million
    shares of a ₹4,000 stock are not comparable, and only one of them can
    absorb a large order.

    The MEDIAN is reported alongside the mean because a single index-rebalance
    day can double a mean and make a thin name look tradable. Where they
    diverge sharply, the median is the one to believe.
    """
    closes, vols = _closes_volumes(candles)
    if not closes:
        return {"adv_value": None, "median_value": None, "adv_shares": None,
                "sessions": 0, "last_close": None}
    closes, vols = closes[-window:], vols[-window:]
    values = [c * v for c, v in zip(closes, vols)]
    live = [v for v in values if v > 0]
    return {
        "adv_value": (sum(live) / len(live)) if live else None,
        "median_value": median(live) if live else None,
        "adv_shares": (sum(vols) / len(vols)) if vols else None,
        "sessions": len(live),
        "last_close": closes[-1],
    }


def days_to_trade(notional: float, adv_value: float | None,
                  participation: float = DEFAULT_PARTICIPATION) -> float | None:
    """Sessions to build (or exit) `notional` at `participation` of ADV.

    None when there is no ADV to divide by — an unquotable or untraded name
    has no answer here, and inventing one is how a position gets sized into
    something that cannot be exited.
    """
    if not adv_value or adv_value <= 0 or participation <= 0 or notional <= 0:
        return None
    return notional / (adv_value * participation)


def classify(days: float | None) -> str:
    """A word for the day count, so a table can be scanned rather than read."""
    if days is None:
        return "unknown"
    if days <= 1:
        return "same day"
    if days <= 5:
        return "days"
    if days <= 20:
        return "weeks"
    if days <= MAX_SENSIBLE_DAYS:
        return "months"
    return "untradable at size"


def profile(candles: list[dict], notional: float,
            participation: float = DEFAULT_PARTICIPATION,
            window: int = WINDOW) -> dict:
    """Everything about one name's capacity to absorb an order."""
    a = adv(candles, window)
    # Size off the median where it is materially below the mean: the mean is
    # the number a single blowout session inflates.
    basis = a["median_value"]
    if basis is None or (a["adv_value"] and basis > a["adv_value"]):
        basis = a["adv_value"]
    d = days_to_trade(notional, basis, participation)
    return {
        **a,
        "basis_value": basis,
        "participation": participation,
        "notional": notional,
        "days": None if d is None else round(d, 2),
        "verdict": classify(d),
    }


def book(history_fn, symbols: list[str], notional_each: float,
         participation: float = DEFAULT_PARTICIPATION,
         period: str = "3M") -> dict:
    """Liquidity profile for a basket, fetched in parallel.

    `history_fn(symbol, period) -> candles` is injected so this module stays
    provider-free and the tests need no network.
    """
    syms = [s for s in dict.fromkeys(s.strip().upper() for s in symbols) if s]
    if not syms:
        return {"names": {}, "summary": _summarise([], notional_each)}

    def one(sym: str) -> tuple[str, dict]:
        try:
            candles = history_fn(sym, period)
        except Exception:
            candles = []
        return sym, profile(candles, notional_each, participation)

    with ThreadPoolExecutor(max_workers=min(8, len(syms))) as pool:
        rows = dict(pool.map(one, syms))
    return {"names": rows, "summary": _summarise(list(rows.values()), notional_each),
            "participation": participation, "window": WINDOW,
            "note": ("Days to trade = notional / (average daily value traded × "
                     f"participation). Participation defaults to "
                     f"{int(DEFAULT_PARTICIPATION * 100)}% of volume, which is "
                     "an upper bound for a patient order, not a target. The "
                     "average uses the lower of the mean and median of the "
                     f"last {WINDOW} sessions, because one index-rebalance day "
                     "can double a mean and make a thin name look tradable. "
                     "Nothing here models market impact, borrow availability "
                     "for a short, or the fact that everyone else sees the "
                     "same liquidity you do.")}


def _summarise(rows: list[dict], notional_each: float) -> dict:
    known = [r for r in rows if r.get("days") is not None]
    buckets: dict[str, int] = {}
    for r in rows:
        buckets[r.get("verdict", "unknown")] = buckets.get(r.get("verdict", "unknown"), 0) + 1
    return {
        "names": len(rows),
        "priced": len(known),
        "unknown": len(rows) - len(known),
        "worst_days": max((r["days"] for r in known), default=None),
        "median_days": median([r["days"] for r in known]) if known else None,
        "notional_each": notional_each,
        "buckets": buckets,
    }
