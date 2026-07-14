"""Comparables sanity: mixed-currency suppression + peer-median outlier clamp."""
from lib.institutional import _clamp_outliers, _mixed_currency, _sane_ps


def test_mixed_currency_detected():
    # INFY.NS case: trades in INR, reports financials in USD.
    assert _mixed_currency({"currency": "INR", "financial_currency": "USD"})
    assert not _mixed_currency({"currency": "INR", "financial_currency": "INR"})
    assert not _mixed_currency({"currency": "INR"})  # unknown -> don't suppress


def test_sane_ps_suppressed_on_mixed_currency():
    f = {"currency": "INR", "financial_currency": "USD",
         "price_to_sales": 221.89, "market_cap": 6.2e12, "revenue": 2.0e10}
    assert _sane_ps(f) is None


def test_sane_ps_computed_when_reported_disagrees():
    f = {"currency": "INR", "financial_currency": "INR",
         "price_to_sales": 221.89, "market_cap": 6.2e12, "revenue": 1.6e12}
    ps = _sane_ps(f)
    assert ps is not None and 3 < ps < 5  # ~3.9, not 221


def test_clamp_outliers_nulls_5x_median():
    rows = [
        {"Ticker": "A", "P/S": 4.0},
        {"Ticker": "B", "P/S": 5.0},
        {"Ticker": "C", "P/S": 6.0},
        {"Ticker": "D", "P/S": 1010.0},  # EV/EBITDA-1010-class garbage
    ]
    out = _clamp_outliers(rows)
    bad = next(r for r in out if r["Ticker"] == "D")
    good = next(r for r in out if r["Ticker"] == "B")
    assert bad["P/S"] is None
    assert good["P/S"] == 5.0
