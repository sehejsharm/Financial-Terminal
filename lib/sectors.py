"""Sector bull/bear ratings for the Indian market.

A rating here is arithmetic, not opinion. Every sector index is scored on
six components — each one a number you can check against a chart — and the
score is a weighted sum of them. The API returns the components alongside
the verdict so the reader can disagree with the weighting rather than having
to trust a label.

    trend       is the index above its 200-day average?
    structure   is the 50-day average above the 200-day?
    relative    3-month return minus the benchmark's 3-month return
    momentum    1-month return
    position    how far below the 52-week high it sits
    breadth     advancers minus decliners among its constituents today

What this is NOT: a forecast, a fundamental view, or a valuation call. It is
a description of price behaviour over the last year. Five of the six
components are trend-following, so the rating will be late at turns — that
caveat travels with the payload rather than living in a footnote nobody
reads.

The scoring is pure and tested. The fetching is separate, so a provider
outage degrades a sector to "no rating, here's why" instead of a made-up
number.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

# Sector index -> the constituents we use for the breadth reading.
#
# Constituents are a representative sample, NOT the official index list:
# NSE does not publish free constituent files we can rely on, and the
# breadth component is deliberately weighted lightest because of it. The
# sample is stated in the payload so nobody mistakes it for the full index.
SECTORS: list[dict] = [
    {
        "key": "it", "label": "IT", "index": "^CNXIT",
        "members": ["TCS.NS", "INFY.NS", "HCLTECH.NS", "WIPRO.NS", "TECHM.NS",
                    "LTIM.NS", "PERSISTENT.NS", "COFORGE.NS", "MPHASIS.NS"],
    },
    {
        "key": "bank", "label": "Banks", "index": "^NSEBANK",
        "members": ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "KOTAKBANK.NS",
                    "AXISBANK.NS", "INDUSINDBK.NS", "BANKBARODA.NS",
                    "PNB.NS", "FEDERALBNK.NS"],
    },
    {
        "key": "auto", "label": "Auto", "index": "^CNXAUTO",
        "members": ["MARUTI.NS", "M&M.NS", "TATAMOTORS.NS", "BAJAJ-AUTO.NS",
                    "EICHERMOT.NS", "HEROMOTOCO.NS", "TVSMOTOR.NS",
                    "BALKRISIND.NS", "ASHOKLEY.NS"],
    },
    {
        "key": "pharma", "label": "Pharma", "index": "^CNXPHARMA",
        "members": ["SUNPHARMA.NS", "CIPLA.NS", "DRREDDY.NS", "DIVISLAB.NS",
                    "TORNTPHARM.NS", "LUPIN.NS", "AUROPHARMA.NS",
                    "ALKEM.NS", "ZYDUSLIFE.NS"],
    },
    {
        "key": "fmcg", "label": "FMCG", "index": "^CNXFMCG",
        "members": ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS",
                    "DABUR.NS", "MARICO.NS", "GODREJCP.NS", "TATACONSUM.NS",
                    "COLPAL.NS"],
    },
    {
        "key": "metal", "label": "Metals", "index": "^CNXMETAL",
        "members": ["TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS",
                    "VEDL.NS", "JINDALSTEL.NS", "SAIL.NS", "NMDC.NS",
                    "NATIONALUM.NS", "HINDZINC.NS"],
    },
    {
        "key": "energy", "label": "Energy", "index": "^CNXENERGY",
        "members": ["RELIANCE.NS", "ONGC.NS", "NTPC.NS", "POWERGRID.NS",
                    "BPCL.NS", "IOC.NS", "GAIL.NS", "COALINDIA.NS",
                    "TATAPOWER.NS"],
    },
    {
        "key": "realty", "label": "Realty", "index": "^CNXREALTY",
        "members": ["DLF.NS", "GODREJPROP.NS", "OBEROIRLTY.NS", "PRESTIGE.NS",
                    "PHOENIXLTD.NS", "BRIGADE.NS", "SOBHA.NS"],
    },
]

BENCHMARK = "^NSEI"

# Component weights. They sum to 1 so the score lands in [-100, 100] and the
# UI can show each contribution as a share of the whole.
WEIGHTS: dict[str, float] = {
    "trend": 0.25,
    "structure": 0.15,
    "relative": 0.25,
    "momentum": 0.15,
    "position": 0.10,
    "breadth": 0.10,
}

COMPONENT_LABEL: dict[str, str] = {
    "trend": "Above 200-day average",
    "structure": "50-day vs 200-day",
    "relative": "3-month vs NIFTY 50",
    "momentum": "1-month return",
    "position": "Distance from 52-week high",
    "breadth": "Constituent breadth today",
}

# Trading days. Approximate by construction — a month is not exactly 21
# sessions — but the alternative is date arithmetic over a series that
# already has holidays punched out of it.
_MONTH = 21
_QUARTER = 63


def _clamp(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def sma(closes: list[float], n: int) -> float | None:
    """Simple moving average of the last n closes, or None if short."""
    if n <= 0 or len(closes) < n:
        return None
    return sum(closes[-n:]) / n


def pct_change(closes: list[float], back: int) -> float | None:
    """Percent change over `back` bars, or None if the history is too short.

    Returns None rather than reaching for closes[0] when the window doesn't
    fit: a "3-month return" computed over five weeks is a different number
    wearing the same label.
    """
    if back <= 0 or len(closes) <= back:
        return None
    prev = closes[-1 - back]
    if prev == 0:
        return None
    return (closes[-1] / prev - 1) * 100


def measure(closes: list[float], bench: list[float] | None = None,
            breadth: float | None = None) -> dict:
    """Raw, unweighted measurements for one sector.

    Every field is None when the history can't support it. Nothing is
    substituted, defaulted to zero, or inferred from a shorter window.
    """
    last = closes[-1] if closes else None
    ma50 = sma(closes, 50)
    ma200 = sma(closes, 200)
    r1m = pct_change(closes, _MONTH)
    r3m = pct_change(closes, _QUARTER)
    r6m = pct_change(closes, _QUARTER * 2)
    b3m = pct_change(bench, _QUARTER) if bench else None

    # 52-week high off the trailing 252 sessions we actually hold, so a short
    # series reports the high of what it has rather than claiming a year.
    window = closes[-252:] if closes else []
    hi = max(window) if window else None
    lo = min(window) if window else None
    dd = ((last / hi - 1) * 100) if (last is not None and hi) else None

    return {
        "last": last,
        "ma50": ma50,
        "ma200": ma200,
        "ret_1m": r1m,
        "ret_3m": r3m,
        "ret_6m": r6m,
        "bench_3m": b3m,
        "relative_3m": (r3m - b3m) if (r3m is not None and b3m is not None) else None,
        "high_52w": hi,
        "low_52w": lo,
        "from_high_pct": dd,
        "breadth": breadth,
        "bars": len(closes),
    }


def components(m: dict) -> dict[str, float | None]:
    """Map raw measurements onto a common [-1, +1] scale.

    The saturation points are stated here rather than buried in the weights:
    a sector 10 points ahead of the index over three months scores a full
    +1 on relative strength, and 20% below its 52-week high scores a full
    -1 on position. Beyond those the exact number stops changing the verdict.
    """
    out: dict[str, float | None] = {}

    out["trend"] = (None if m["last"] is None or m["ma200"] is None
                    else (1.0 if m["last"] >= m["ma200"] else -1.0))

    out["structure"] = (None if m["ma50"] is None or m["ma200"] is None
                        else (1.0 if m["ma50"] >= m["ma200"] else -1.0))

    out["relative"] = (None if m["relative_3m"] is None
                       else _clamp(m["relative_3m"] / 10.0))

    out["momentum"] = (None if m["ret_1m"] is None
                       else _clamp(m["ret_1m"] / 8.0))

    # from_high_pct is <= 0. At the high -> +1; 20% below -> -1.
    out["position"] = (None if m["from_high_pct"] is None
                       else _clamp(1 + m["from_high_pct"] / 10.0))

    out["breadth"] = None if m["breadth"] is None else _clamp(m["breadth"])

    return out


# Rating bands over the -100..+100 score.
BANDS: list[tuple[float, str]] = [
    (50, "Strong bull"),
    (20, "Bull"),
    (-20, "Neutral"),
    (-50, "Bear"),
]


def band(score: float) -> str:
    for threshold, name in BANDS:
        if score >= threshold:
            return name
    return "Strong bear"


def score(comps: dict[str, float | None]) -> dict:
    """Weighted score over whatever components are available.

    Missing components are dropped and the remaining weights are
    renormalised, so a sector with no breadth reading is not silently
    penalised as if its breadth were zero. If fewer than half the weight is
    available the rating is withheld entirely — a verdict from two of six
    inputs is a guess with a label on it.
    """
    used = {k: v for k, v in comps.items() if v is not None}
    weight = sum(WEIGHTS[k] for k in used)
    if weight < 0.5:
        return {
            "score": None, "rating": None, "coverage": round(weight, 3),
            "contributions": {}, "reason": "Not enough price history to rate.",
        }
    raw = sum(WEIGHTS[k] * v for k, v in used.items()) / weight
    s = round(raw * 100, 1)
    return {
        "score": s,
        "rating": band(s),
        "coverage": round(weight, 3),
        "contributions": {k: round(WEIGHTS[k] * v / weight * 100, 1)
                          for k, v in used.items()},
        "reason": None,
    }


def rate(closes: list[float], bench: list[float] | None = None,
         breadth: float | None = None) -> dict:
    """measure -> components -> score, in one call."""
    m = measure(closes, bench, breadth)
    c = components(m)
    return {**score(c), "measures": m, "components": c}


# ── fetching ────────────────────────────────────────────────────────────

def _closes(candles: list[dict]) -> list[float]:
    out: list[float] = []
    for c in candles or []:
        v = c.get("close") if isinstance(c, dict) else None
        if v is None:
            v = c.get("Close") if isinstance(c, dict) else None
        try:
            if v is not None:
                out.append(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _breadth(quotes: dict[str, dict | None]) -> tuple[float | None, int, int, int]:
    """(net breadth in [-1,1], advancers, decliners, quoted)."""
    adv = dec = 0
    for q in quotes.values():
        if not q:
            continue
        cp = q.get("change_pct")
        if cp is None:
            continue
        if cp > 0:
            adv += 1
        elif cp < 0:
            dec += 1
    n = adv + dec
    return ((adv - dec) / n if n else None), adv, dec, n


def get_sector_board(history_fn, quotes_fn, period: str = "1Y") -> dict:
    """Rate every sector.

    `history_fn(symbol, period) -> list[candle]` and
    `quotes_fn(list[symbol]) -> {symbol: quote}` are injected so this module
    stays free of provider imports and the tests need no network.
    """
    bench = _closes(history_fn(BENCHMARK, period))

    def one(sec: dict) -> dict:
        closes = _closes(history_fn(sec["index"], period))
        quotes = quotes_fn(sec["members"]) or {}
        net, adv, dec, quoted = _breadth(quotes)
        r = rate(closes, bench or None, net)
        return {
            "key": sec["key"], "label": sec["label"], "index": sec["index"],
            "advancers": adv, "decliners": dec,
            "members_quoted": quoted, "members_total": len(sec["members"]),
            **r,
        }

    with ThreadPoolExecutor(max_workers=min(8, len(SECTORS))) as pool:
        rows = list(pool.map(one, SECTORS))

    rated = [r for r in rows if r["score"] is not None]
    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0)))
    return {
        "benchmark": BENCHMARK,
        "sectors": rows,
        "rated": len(rated),
        "weights": WEIGHTS,
        "component_labels": COMPONENT_LABEL,
        "note": ("Ratings are arithmetic over the last year of index prices: "
                 "trend, 50/200 structure, 3-month strength against NIFTY 50, "
                 "1-month momentum, distance from the 52-week high, and "
                 "constituent breadth today. Five of the six are "
                 "trend-following, so ratings turn late. Breadth uses a "
                 "representative sample of each sector, not the official "
                 "index membership, which is why it carries the lightest "
                 "weight. This is a description of price behaviour, not a "
                 "forecast or a valuation view."),
    }
