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


def test_delta_moneyness_extremes():
    """Deep OTM call delta → 0, deep ITM call delta → 1 (QA repro: chain
    showed Δ=1.000 for EVERY strike when Yahoo IV was missing)."""
    from lib.options import black_scholes_greeks
    S, T, r, iv = 100.0, 0.25, 0.05, 0.30
    otm = black_scholes_greeks(S, 200.0, T, r, iv, kind="call")
    itm = black_scholes_greeks(S, 40.0, T, r, iv, kind="call")
    atm = black_scholes_greeks(S, 100.0, T, r, iv, kind="call")
    assert float(otm["delta"]) < 0.01
    assert float(itm["delta"]) > 0.99
    assert 0.4 < float(atm["delta"]) < 0.7


def test_missing_iv_solved_from_price_not_zeroed():
    """Rows with junk Yahoo IV get IV re-solved from bid/ask mid; the solved
    IV is nonzero and delta reflects moneyness instead of pinning at 1."""
    import pandas as pd
    from lib.options import enrich_with_greeks, _bs_price_scalar

    S, T, r = 100.0, 0.25, 0.05
    # Fair prices at 30% vol for an OTM and an ITM call.
    px_otm = _bs_price_scalar(S, 120.0, T, r, 0.30, "call")
    px_itm = _bs_price_scalar(S, 80.0, T, r, 0.30, "call")
    df = pd.DataFrame([
        {"strike": 120.0, "impliedVolatility": 1e-5,  # Yahoo placeholder
         "bid": px_otm * 0.99, "ask": px_otm * 1.01, "lastPrice": px_otm,
         "volume": 500, "openInterest": 1000},
        {"strike": 80.0, "impliedVolatility": float("nan"),
         "bid": px_itm * 0.99, "ask": px_itm * 1.01, "lastPrice": px_itm,
         "volume": 300, "openInterest": 800},
    ])
    out = enrich_with_greeks(df, S, T, r, "call")
    ivs = out["impliedVolatility"].tolist()
    deltas = out["delta"].tolist()
    assert all(iv > 0.05 for iv in ivs), f"IV not solved: {ivs}"
    assert abs(ivs[0] - 0.30) < 0.05 and abs(ivs[1] - 0.30) < 0.05
    assert deltas[0] < 0.5 < deltas[1]          # OTM < ATM < ITM ordering
    assert deltas[0] > 0.001 and deltas[1] < 0.999


def test_unpriceable_rows_get_nan_not_fake_greeks():
    """No IV and no usable price → NaN Greeks (renders as '—'), never a
    fabricated Δ=1.000 / IV=0.00 row."""
    import math
    import pandas as pd
    from lib.options import enrich_with_greeks

    df = pd.DataFrame([{"strike": 150.0, "impliedVolatility": float("nan"),
                        "bid": 0.0, "ask": 0.0, "lastPrice": 0.0,
                        "volume": 0, "openInterest": 0}])
    out = enrich_with_greeks(df, 100.0, 0.25, 0.05, "call")
    assert math.isnan(out["delta"].iloc[0])
    assert math.isnan(out["impliedVolatility"].iloc[0])


def test_implied_vol_solver_roundtrip():
    from lib.options import _bs_price_scalar, implied_vol_from_price
    for sigma in (0.15, 0.30, 0.60):
        for K in (80.0, 100.0, 120.0):
            px = _bs_price_scalar(100.0, K, 0.5, 0.05, sigma, "call")
            solved = implied_vol_from_price(px, 100.0, K, 0.5, 0.05, "call")
            assert solved is not None
            assert abs(solved - sigma) < 1e-3
