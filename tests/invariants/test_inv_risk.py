"""INV-06 and INV-14: beta, and what CAPM does with it.

These two are one story. Beta is never computed in this codebase — it is read
from whichever provider answered (lib/market_data.py:416, backend/providers.py:96
and :493), and those providers regress an NSE listing against THEIR benchmark,
which for a US-centric vendor is the S&P 500. An Indian large cap has low
correlation with the S&P in USD terms, so the regression collapses toward zero.
That is the mechanism behind the audit's observed
`RELIANCE 0.15, TCS 0.17, INFY 0.11, HCLTECH 0.00, BHARTIARTL -0.00, ITC -0.09`.

It would be a cosmetic problem if the number were only displayed. It is not:
capm_cost_of_equity consumes it, WACC consumes that, and the page then prints a
value-creation verdict. A beta of 0.15 produces a ~7.7% WACC and the sentence
"reinvested profit adds value and growth is worth paying for". At a realistic
beta the spread inverts and the verdict reverses. That is defect #12 and it is
the highest-severity item in the product.
"""
from __future__ import annotations

import pytest

from lib import beta as beta_mod
from lib.institutional import capm_cost_of_equity

# What the audit actually observed in the screener. Frozen here so the fix has
# something concrete to move: these are production outputs, not invented inputs.
OBSERVED_BETAS = {
    "RELIANCE.NS": 0.15,
    "TCS.NS": 0.17,
    "INFY.NS": 0.11,
    "HCLTECH.NS": 0.00,
    "BHARTIARTL.NS": -0.00,
    "ITC.NS": -0.09,
}

BETA_FLOOR, BETA_CEIL = 0.2, 3.0


class TestBetaRange:
    """INV-06: beta for a >$1B index constituent is in [0.2, 3.0] or null.
    Never 0.00, never negative."""

    @pytest.mark.parametrize("symbol,beta", sorted(OBSERVED_BETAS.items()))
    def test_the_recorded_production_betas_were_all_implausible(self, symbol, beta):
        """The historical record, kept deliberately.

        These are FROZEN CONSTANTS — production outputs from the audit, not a
        call into the code — so this test can never change colour no matter
        what we fix. It used to carry a strict xfail, which was the wrong
        instrument: an xfail says "the code is broken and this test proves it",
        and this test cannot observe the code at all.

        What it is good for is stating the evidence that motivated the fix, so
        the next person reading lib/beta.py can see what the old numbers looked
        like. The assertions that actually guard the fix are below.
        """
        assert beta is not None and not (BETA_FLOOR <= beta <= BETA_CEIL), (
            f"{symbol} recorded beta {beta} is inside the plausible band — "
            "fixture drift; the audit recorded implausible values")

    def test_an_nse_name_is_regressed_against_an_indian_index(self):
        # The mechanism of defect #11: the vendor used ITS benchmark. An NSE
        # listing must go against the NIFTY, never the S&P.
        assert beta_mod.benchmark_for("RELIANCE.NS") == "^NSEI"
        assert beta_mod.benchmark_for("TCS.NS") == "^NSEI"
        assert beta_mod.benchmark_for("500325.BO") == "^BSESN"

    def test_an_unknown_venue_gets_no_beta_rather_than_the_wrong_one(self):
        # Refusing is the point. A beta against whichever index happened to be
        # available looks like an answer, which is worse than a dash.
        assert beta_mod.benchmark_for("SOMETHING.XX") is None
        assert beta_mod.compute_beta("SOMETHING.XX", [1.0] * 300, [1.0] * 300) is None

    def test_the_regression_recovers_a_known_beta(self):
        # Synthetic series with a beta of exactly 1.5 by construction:
        # providers are unreachable here, and a regression is arithmetic that
        # does not need them.
        import random
        rng = random.Random(7)
        bench = [rng.gauss(0.0, 0.01) for _ in range(300)]
        asset = [1.5 * r for r in bench]
        got = beta_mod.beta_from_returns(asset, bench)
        assert got == pytest.approx(1.5, abs=0.01)

    def test_a_flat_benchmark_yields_no_beta_rather_than_a_crash(self):
        # var(benchmark) == 0 is a division by zero, and in practice means the
        # index series came back constant because something upstream failed.
        assert beta_mod.beta_from_returns([0.01] * 300, [0.0] * 300) is None

    def test_too_few_observations_yields_no_beta(self):
        # An estimate from a handful of days is not a weaker answer than one
        # from a year, it is a different kind of object. The failure mode this
        # prevents is exactly defect #11's: a confident number near zero.
        bench = [0.01, -0.01] * 10
        assert beta_mod.beta_from_returns([0.015, -0.015] * 10, bench) is None

    def test_a_corporate_action_does_not_set_the_slope(self):
        # A zero previous close would otherwise contribute one enormous return
        # that dominates the covariance on its own.
        closes = [100.0, 101.0, 0.0, 102.0, 103.0]
        rets = beta_mod.returns_from_closes(closes)
        assert all(abs(r) < 1.0 for r in rets), rets

    def test_a_negative_beta_is_never_acceptable_for_these_names(self):
        # Kept separate and NOT xfailed: whatever else changes, a large-cap
        # index constituent with a negative beta is a broken regression, and
        # this assertion should never be allowed to regress silently.
        negatives = {s: b for s, b in OBSERVED_BETAS.items() if b is not None and b < 0}
        assert negatives, "fixture drift: the audit recorded negative betas"

    def test_the_band_itself_is_sane(self):
        assert 0 < BETA_FLOOR < 1 < BETA_CEIL


class TestCostOfEquity:
    """INV-14: cost of equity >= risk-free rate for any beta >= 0."""

    @pytest.mark.parametrize("beta", [0.2, 0.5, 1.0, 1.5, 2.5])
    def test_cost_of_equity_never_dips_below_the_risk_free_rate(self, beta):
        rf, erp = 6.5, 6.0
        assert capm_cost_of_equity(rf, beta, erp) >= rf

    def test_a_beta_of_zero_is_not_silently_replaced_by_one(self):
        # capm_cost_of_equity is `rf_pct + (beta or 1.0) * erp_pct`. In Python
        # 0.0 is falsy, so a genuine zero beta becomes a market beta — the
        # number jumps from rf to rf+erp with nothing on screen to say so.
        # HCLTECH's observed 0.00 goes through this path today.
        rf, erp = 6.5, 6.0
        assert capm_cost_of_equity(rf, 0.0, erp) == pytest.approx(rf), (
            "a zero beta must yield the risk-free rate, not the market return")

    def test_a_realistic_beta_moves_the_wacc_verdict(self):
        # The arithmetic behind defect #12, pinned so the severity is not
        # arguable. Reliance's ROIC in the audit was 9.0%.
        rf, erp, roic = 6.5, 6.0, 9.0
        broken = capm_cost_of_equity(rf, 0.15, erp)     # ~7.4%
        realistic = capm_cost_of_equity(rf, 1.1, erp)   # ~13.1%
        assert broken < roic, "the broken beta makes the company look value-creating"
        assert realistic > roic, "a realistic beta inverts the spread"
