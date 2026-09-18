"""INV-02 and INV-10: movers ordering, and never mixing period bases.

INV-02 is a control. The audit found the dashboard's Top Gainers ranking
`DRREDDY +0.02%` above `JSWSTEEL +0.07%` and including `ULTRACEMCO -0.02%`,
with `TCS +0.12%` sitting in Top Losers — neither sign-filtered nor
magnitude-sorted. The ranking has since been given a sign filter, so these
assertions should PASS. That is the point: a suite where every rule fails
teaches nothing about which rules actually bite.

INV-10 guards the defect that poisons every growth figure downstream. Indian
XBRL is cumulative year-to-date, so a filing series reads Q1 / H1 / 9M / FY —
the audit's Reliance numbers `6.74T / 9.14T / 2.36T / 4.72T / 7.16T` are those
four windows, not four quarters. Put a 9M figure in a quarterly column and
every CAGR, growth %, common-size ratio and per-share metric computed from it
is wrong, while looking entirely reasonable.
"""
from __future__ import annotations

import pytest

from lib.market_data import rank_movers
from lib.nse_xbrl import period_shape


def rows(*pcts):
    return [{"symbol": f"T{i}", "change_pct": p, "turnover": 1_000 - i}
            for i, p in enumerate(pcts)]


class TestMoversOrdering:
    """INV-02: gainers all > 0 and strictly descending; losers all < 0 and
    strictly ascending."""

    # The exact shape the audit observed: a mixed-sign board in near-flat
    # trading, which is when sign errors are least visible and most likely.
    NEAR_FLAT = (0.02, 0.07, -0.02, -0.05, -0.10, 0.12, 0.00, -0.31, 0.45)

    def test_every_gainer_rose_and_they_descend(self):
        got = rank_movers(rows(*self.NEAR_FLAT), "gainers", 8)
        pcts = [r["change_pct"] for r in got]
        assert all(p > 0 for p in pcts), f"non-gainer in gainers: {pcts}"
        assert pcts == sorted(pcts, reverse=True), f"not descending: {pcts}"

    def test_every_loser_fell_and_they_ascend(self):
        got = rank_movers(rows(*self.NEAR_FLAT), "losers", 8)
        pcts = [r["change_pct"] for r in got]
        assert all(p < 0 for p in pcts), f"non-loser in losers: {pcts}"
        assert pcts == sorted(pcts), f"not ascending (worst first): {pcts}"

    def test_a_flat_name_is_in_neither_list(self):
        flat = rows(0.0)
        assert rank_movers(flat, "gainers", 8) == []
        assert rank_movers(flat, "losers", 8) == []

    def test_an_all_up_session_yields_no_losers(self):
        # Returning the weakest risers as "losers" is the original defect.
        assert rank_movers(rows(5.0, 4.0, 3.0, 2.0, 1.0), "losers", 8) == []

    @pytest.mark.parametrize("kind", ["gainers", "losers"])
    def test_ranking_is_stable_under_input_order(self, kind):
        a = rank_movers(rows(*self.NEAR_FLAT), kind, 8)
        b = rank_movers(rows(*reversed(self.NEAR_FLAT)), kind, 8)
        assert [r["change_pct"] for r in a] == [r["change_pct"] for r in b]


class TestPeriodBases:
    """INV-10: a discrete period never sits in a series with a cumulative one."""

    from datetime import date

    def test_the_four_indian_reporting_windows_are_told_apart(self):
        from datetime import date
        # Q1, H1, 9M, FY off an April fiscal year start — the exact ladder
        # behind the Reliance series in the audit.
        assert period_shape(date(2024, 4, 1), date(2024, 6, 30)) == "quarter"
        assert period_shape(date(2024, 4, 1), date(2024, 9, 30)) == "half"
        assert period_shape(date(2024, 4, 1), date(2024, 12, 31)) == "nine_month"
        assert period_shape(date(2024, 4, 1), date(2025, 3, 31)) == "year"

    def test_a_cumulative_window_is_never_classified_as_a_quarter(self):
        from datetime import date
        # This is the assertion that stops a 9M figure reaching a quarterly
        # column. If it ever fails, defect #9 is back.
        for start, end in [
            (date(2024, 4, 1), date(2024, 9, 30)),      # H1
            (date(2024, 4, 1), date(2024, 12, 31)),     # 9M
            (date(2024, 4, 1), date(2025, 3, 31)),      # FY
        ]:
            assert period_shape(start, end) != "quarter"

    def test_an_unrecognised_span_is_refused_rather_than_bucketed(self):
        from datetime import date
        # A 45-day stub is not a quarter. Forcing it into the nearest bucket is
        # how half a quarter's revenue ends up in a quarterly column.
        assert period_shape(date(2024, 10, 1), date(2024, 11, 14)) is None
        assert period_shape(None, date(2024, 12, 31)) is None
