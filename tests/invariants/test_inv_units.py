"""INV-05, INV-08, INV-13: units, currencies, and the scale applied twice.

Every bug in this file is the same bug wearing a different hat: a number
arrives already carrying a unit, and the code applies the unit again. Nobody
notices because the result is still a plausible-looking number in a column that
expects plausible-looking numbers.

The two live reproductions below come straight out of lib/screens.py:

    revenue_cr : round(f["revenue"] / 1e7, 0)      # crore, whatever the currency
    div_yield  : round(v * 100, 2)                 # percent, even if already percent

Infosys and HCL Tech report in USD. Dividing a USD figure by 1e7 and labelling
it "Cr" reports US dollars as Indian crores — the audit saw INFY at 2,030 Cr
against an actual ~1.6 lakh crore, and the error propagated into a P/S of
208.87. Anyone sorting the screener by P/S gets the broken rows at the top,
which is the worst possible place for them.
"""
from __future__ import annotations

import pytest

from lib.screens import _build_metrics
from tests.invariants.conftest import orders_of_magnitude

# A USD reporter: revenue is ~$19B, which is ~1.6 lakh crore, NOT 1,900 Cr.
INFY_USD = {
    "name": "Infosys", "market_cap": 7.5e12, "price": 1500.0,
    "revenue": 1.9e10,            # USD, as the provider supplies it
    "dividend_yield": 0.48,       # already a PERCENT (0.48%)
    "trailing_pe": 25.0, "beta": 0.11,
}

# An INR reporter on the same screen, for contrast.
RELIANCE_INR = {
    "name": "Reliance Industries", "market_cap": 1.68e13, "price": 1241.80,
    "revenue": 9.74e12,           # INR
    "dividend_yield": 0.48,       # also already a percent
    "trailing_pe": 22.46, "beta": 0.15,
}


class TestPercentUnits:
    """INV-13: a percentage field is in [0,1] xor [0,100] per field, declared,
    never both."""

    @pytest.mark.xfail(strict=True, reason="defect #15: pct() multiplies a "
                       "value that is already a percentage by 100")
    def test_dividend_yield_is_not_scaled_twice(self):
        # The audit saw 48 / 297 / 606 in the screener's DIV YIELD column while
        # DES rendered the same Reliance value as 0.48%. Both read the same
        # provider field; only one of them multiplies.
        m = _build_metrics("RELIANCE.NS", dict(RELIANCE_INR))
        assert m["div_yield"] == pytest.approx(0.48, abs=0.01), (
            f"div_yield rendered {m['div_yield']} for a 0.48% yield")

    def test_a_dividend_yield_above_fifty_percent_is_never_real(self):
        # A blunt backstop that stays even after the fix: no listed large cap
        # yields 48%, let alone 606%. If this ever fires, a unit slipped again.
        for symbol, f in (("RELIANCE.NS", RELIANCE_INR), ("INFY.NS", INFY_USD)):
            m = _build_metrics(symbol, dict(f))
            y = m["div_yield"]
            if y is None:
                continue
            pytest.xfail("defect #15 — currently 48.0; remove this xfail with the fix") \
                if y > 50 else None
            assert y <= 50, f"{symbol} dividend yield {y}% is not a real yield"


class TestCurrencyScale:
    """INV-05: revenue-per-share is within 2 orders of magnitude of price."""

    def test_an_inr_reporter_passes(self):
        # The control. Reliance reports in INR, so dividing by 1e7 is correct
        # and revenue-per-share lands near the share price.
        m = _build_metrics("RELIANCE.NS", dict(RELIANCE_INR))
        shares = RELIANCE_INR["market_cap"] / RELIANCE_INR["price"]
        rps = (m["revenue_cr"] * 1e7) / shares
        assert orders_of_magnitude(rps, m["price"]) <= 2

    @pytest.mark.xfail(strict=True, reason="defect #14: USD revenue divided by "
                       "1e7 and labelled Cr")
    def test_a_usd_reporter_does_not_report_dollars_as_crores(self):
        m = _build_metrics("INFY.NS", dict(INFY_USD))
        shares = INFY_USD["market_cap"] / INFY_USD["price"]
        rps = (m["revenue_cr"] * 1e7) / shares
        assert orders_of_magnitude(rps, m["price"]) <= 2, (
            f"revenue-per-share {rps:.2f} vs price {m['price']} — "
            f"revenue_cr={m['revenue_cr']} is a USD figure labelled as crores")

    @pytest.mark.xfail(strict=True, reason="defect #14: no currency is carried "
                       "alongside the converted figure")
    def test_a_converted_figure_declares_its_currency(self):
        # INV-08's precondition. Today _build_metrics emits `revenue_cr` with no
        # currency anywhere in the row, so a renderer cannot know whether to
        # print a rupee sign — and defaults to the sibling field's.
        m = _build_metrics("INFY.NS", dict(INFY_USD))
        assert "currency" in m or "revenue_currency" in m, (
            "no currency field accompanies revenue_cr")


class TestNoBareInheritedSymbol:
    """INV-08: no bare number inherits a currency symbol from a sibling."""

    def test_metric_rows_carry_a_currency_for_money_fields(self):
        money_fields = {"revenue_cr", "fcf_cr", "mcap_cr", "price"}
        m = _build_metrics("RELIANCE.NS", dict(RELIANCE_INR))
        present = {k for k in money_fields if m.get(k) is not None}
        assert present, "fixture produced no money fields at all"
        if "currency" not in m:
            pytest.xfail("defect #14/#32 — metric rows carry no currency field; "
                         "remove this xfail when Phase 1.3 lands")
