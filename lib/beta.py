"""Beta, computed here rather than taken from whoever answered.

DEFECT #11. Beta was never computed in this codebase — it was read from
whichever provider replied (backend/providers.py, lib/market_data.py), and
those vendors regress an NSE listing against THEIR benchmark, which for a
US-centric vendor is the S&P 500. An Indian large cap has low correlation with
the S&P measured in USD, so the regression collapses toward zero. That is the
mechanism behind the values the audit recorded in production:

    RELIANCE 0.15   TCS 0.17   INFY 0.11
    HCLTECH 0.00    BHARTIARTL -0.00   ITC -0.09

Six NIFTY constituents moving independently of the market would be a remarkable
finding. Six of them at once is a broken regression.

It was not cosmetic. capm_cost_of_equity consumes beta, WACC consumes that, and
the page prints a value-creation verdict — and the verdict flips sign across
this range. A beta of 0.15 produces a cost of equity low enough to make almost
any growth look worth paying for.

WHAT THIS MODULE DOES, AND WHAT IT REFUSES TO DO

It regresses the instrument's returns against an INDIAN benchmark (^NSEI for
NSE listings) over a stated window, and it returns None rather than a number
whenever the inputs cannot support one. The refusals are the point: a beta is a
statistical estimate, and an estimate from 11 observations is not a weaker
answer than one from 250, it is a different kind of object. Showing "—" is
honest; showing 0.0 is not.
"""
from __future__ import annotations

import math
from typing import Sequence

#: The benchmark a listing should be regressed against, by venue suffix.
#: Regressing an NSE name against the S&P is the whole of defect #11, so the
#: mapping is explicit and an unknown venue gets no beta rather than a wrong one.
BENCHMARK_BY_SUFFIX = {
    ".NS": "^NSEI",     # NSE  -> NIFTY 50
    ".BO": "^BSESN",    # BSE  -> SENSEX
}

#: US listings, for completeness: these genuinely do belong against the S&P.
DEFAULT_US_BENCHMARK = "^GSPC"

#: Minimum paired observations before a regression means anything.
#:
#: 60 trading days is about three months. Below that the standard error on the
#: slope is wide enough that the point estimate is not worth printing, and the
#: failure mode is specifically the one this module exists to prevent — a
#: confident-looking number near zero.
MIN_OBSERVATIONS = 60

#: Beyond this, the result is almost certainly an artefact rather than a
#: measurement. Kept wide on purpose: real betas do reach 2+ for small caps and
#: cyclicals, so this is a sanity bound, not a plausibility filter.
MAX_PLAUSIBLE_BETA = 4.0


def benchmark_for(symbol: str) -> str | None:
    """The index `symbol` should be regressed against, or None if unknown.

    None matters: it is what stops the code falling back to a benchmark that
    happens to be available. A beta against the wrong index is worse than no
    beta, because it looks like an answer.
    """
    if not symbol:
        return None
    for suffix, bench in BENCHMARK_BY_SUFFIX.items():
        if symbol.upper().endswith(suffix):
            return bench
    if "." not in symbol:            # bare ticker -> US listing
        return DEFAULT_US_BENCHMARK
    return None


def returns_from_closes(closes: Sequence[float]) -> list[float]:
    """Simple period returns from a close series, skipping unusable pairs.

    A pair involving a non-positive close is dropped on BOTH sides, not just
    when it is the denominator. Dropping only a zero `prev` was the first
    version of this and it was half a fix: the pair (101.0 -> 0.0) still
    produced a clean -100% move, and one -1.0 return dominates the covariance
    and sets the slope on its own. A zero or negative close is bad data
    whichever side of the pair it lands on — a share does not go to zero and
    come back the next day, that is a provider gap or an unadjusted corporate
    action.
    """
    out: list[float] = []
    for prev, cur in zip(closes, closes[1:]):
        if not isinstance(prev, (int, float)) or not isinstance(cur, (int, float)):
            continue
        if math.isnan(prev) or math.isnan(cur):
            continue
        if prev <= 0 or cur <= 0:
            continue
        out.append((cur - prev) / prev)
    return out


def beta_from_returns(asset: Sequence[float],
                      benchmark: Sequence[float]) -> float | None:
    """OLS slope of asset returns on benchmark returns: cov(a,b) / var(b).

    Returns None when the inputs cannot support an estimate — too few paired
    observations, or a benchmark with no variance (which would be a division by
    zero, and in practice means the index series is flat or constant because
    something upstream went wrong).
    """
    n = min(len(asset), len(benchmark))
    if n < MIN_OBSERVATIONS:
        return None
    a, b = list(asset[:n]), list(benchmark[:n])

    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b)) / n
    var_b = sum((y - mean_b) ** 2 for y in b) / n
    if var_b <= 0:
        return None

    slope = cov / var_b
    if not math.isfinite(slope) or abs(slope) > MAX_PLAUSIBLE_BETA:
        # Out of range is a symptom, not a finding. Returning None keeps it out
        # of CAPM rather than letting it set a cost of equity.
        return None
    return slope


def compute_beta(symbol: str,
                 asset_closes: Sequence[float],
                 benchmark_closes: Sequence[float]) -> float | None:
    """Beta for `symbol` from two aligned close series, or None.

    The caller is responsible for fetching series that cover the SAME dates —
    misaligned series produce a meaningless slope, and this function cannot
    tell. lib/market_data.get_history_bulk returns a dict keyed by symbol for
    exactly this reason.
    """
    if benchmark_for(symbol) is None:
        return None
    return beta_from_returns(returns_from_closes(asset_closes),
                             returns_from_closes(benchmark_closes))


# ── the plausible band, and what to do with a provider's number ───────────
#
# These match the INV-06 invariant: beta for a large, liquid index constituent
# sits in [0.2, 3.0] or is null. Never exactly zero, never negative.
PLAUSIBLE_FLOOR, PLAUSIBLE_CEIL = 0.2, 3.0


def sanitise_provider_beta(value: float | None) -> float | None:
    """A provider's beta, or None when it cannot be believed.

    This is the stopgap half of the fix, and it is the half that works without
    a network. Computing beta ourselves (compute_beta above) is the real
    answer, but it needs two price histories per name and a screener scans
    seventy of them — so when we fall back to the vendor's number, we at least
    refuse the ones the invariant calls impossible.

    THE TRADEOFF, stated because it is a real one: the band will also reject a
    genuinely low-beta instrument. A defensive name at 0.18 becomes a dash. I
    think that is the right way to be wrong here — this value feeds CAPM, then
    WACC, then a printed verdict on whether growth is worth paying for, and the
    verdict flips sign across this range. A dash makes someone go and look. A
    0.15 that came from a regression against the S&P makes them believe a
    sentence that was computed from the wrong index.
    """
    if not isinstance(value, (int, float)):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    if not (PLAUSIBLE_FLOOR <= value <= PLAUSIBLE_CEIL):
        return None
    return float(value)


def beta_for(symbol: str, history_fn, period: str = "5Y") -> float | None:
    """Compute beta for `symbol` by regressing it against its own index.

    `history_fn(ticker, period)` must return something with a "Close" column —
    lib.market_data.get_history satisfies this. Injected rather than imported
    so this module stays pure and testable without a network, which is the
    only reason any of it could be verified here at all.

    Returns None on any failure. That is deliberate and not laziness: the
    caller's fallback is sanitise_provider_beta, and a wrong beta is worse than
    an absent one.
    """
    bench = benchmark_for(symbol)
    if bench is None:
        return None
    try:
        asset_df = history_fn(symbol, period)
        bench_df = history_fn(bench, period)
    except Exception:
        return None
    try:
        asset = [float(x) for x in asset_df["Close"].tolist()]
        marker = [float(x) for x in bench_df["Close"].tolist()]
    except Exception:
        return None
    # Lengths can differ when one series has extra sessions. Aligning on dates
    # would be better; taking the common tail is the honest approximation and
    # is noted as such — a date-aligned join belongs with the live wiring.
    n = min(len(asset), len(marker))
    if n < MIN_OBSERVATIONS:
        return None
    return beta_from_returns(returns_from_closes(asset[-n:]),
                             returns_from_closes(marker[-n:]))
