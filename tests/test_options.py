"""Black-Scholes sanity checks (pure math, no network)."""
import math

from lib.options import black_scholes_greeks, max_pain, years_to_expiry


def test_call_and_put_prices_positive():
    call = black_scholes_greeks(100, 100, 1.0, 0.05, 0.2, kind="call")
    put = black_scholes_greeks(100, 100, 1.0, 0.05, 0.2, kind="put")
    assert float(call["price"]) > 0
    assert float(put["price"]) > 0


def test_put_call_parity():
    # C - P = S - K*e^(-rT)  (no dividends)
    S, K, T, r, sig = 100, 95, 0.5, 0.03, 0.25
    c = float(black_scholes_greeks(S, K, T, r, sig, kind="call")["price"])
    p = float(black_scholes_greeks(S, K, T, r, sig, kind="put")["price"])
    lhs = c - p
    rhs = S - K * math.exp(-r * T)
    assert abs(lhs - rhs) < 1e-2


def test_delta_ranges():
    call_delta = float(black_scholes_greeks(100, 100, 1, 0.05, 0.2, kind="call")["delta"])
    put_delta = float(black_scholes_greeks(100, 100, 1, 0.05, 0.2, kind="put")["delta"])
    assert 0 <= call_delta <= 1
    assert -1 <= put_delta <= 0


def test_years_to_expiry_non_negative():
    assert years_to_expiry("2000-01-01") == 0.0  # past date clamps to 0
    assert years_to_expiry("not-a-date") == 0.0


def test_max_pain_handles_empty():
    import pandas as pd
    assert max_pain(pd.DataFrame(), pd.DataFrame()) is None
