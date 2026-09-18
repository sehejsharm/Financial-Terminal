"""Shared machinery for the invariant suite (Phase 0.2).

An invariant is a rule that must hold for EVERY ticker, not an example that
happens to work for one. The audit found the same class of bug over and over —
a unit applied twice, a sign never checked, a metric read from whichever
provider answered first — so each rule here is one of those classes,
generalised so it cannot come back somewhere else.

Two conventions make this suite worth keeping:

STRICT XFAIL. A rule the code currently violates is marked
`@pytest.mark.xfail(strict=True, reason="defect #N")`. The suite stays green on
main, so it can be a required check immediately, and the moment someone fixes
the defect the xfail turns into an XPASS *failure* that forces the marker to be
removed. A rule that quietly starts passing and nobody notices is a rule that
quietly starts failing again later.

NO NETWORK. Everything runs off frozen fixtures. See scripts/capture_fixtures.py.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

GOLDEN = Path(__file__).resolve().parent.parent / "fixtures" / "golden"
RAW = GOLDEN / "raw"


@pytest.fixture(scope="session")
def universe() -> list[dict]:
    """The 20-ticker golden set, with the identity facts invariants judge by."""
    return json.loads((GOLDEN / "universe.json").read_text())["tickers"]


@pytest.fixture(scope="session")
def by_symbol(universe) -> dict[str, dict]:
    return {t["symbol"]: t for t in universe}


def load_raw(probe: str, symbol: str):
    """A captured provider payload, or None when it has not been captured yet.

    Returning None rather than raising is deliberate: this repo is developed in
    an environment with no route to the data providers, so most fixtures are
    absent. Tests skip on absence and run for real on a machine where
    scripts/capture_fixtures.py has been run — the rules stay in the suite
    either way instead of being deleted and forgotten.
    """
    path = RAW / probe / f"{symbol.replace('^', '_idx_')}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def require_raw(probe: str, symbol: str):
    payload = load_raw(probe, symbol)
    if payload is None:
        pytest.skip(f"fixture not captured: {probe}/{symbol} "
                    f"(run scripts/capture_fixtures.py on a networked machine)")
    if isinstance(payload, dict) and "_error" in payload:
        pytest.skip(f"fixture records a provider failure: {payload['_error']}")
    return payload


# ── shared numeric helpers ────────────────────────────────────────────────

def is_pct_fraction(v: float) -> bool:
    """Looks like a 0-1 fraction rather than a 0-100 percentage."""
    return 0.0 <= v <= 1.0


def orders_of_magnitude(a: float, b: float) -> float:
    """How many powers of ten separate two positive numbers."""
    import math
    if a <= 0 or b <= 0:
        return float("inf")
    return abs(math.log10(a) - math.log10(b))
