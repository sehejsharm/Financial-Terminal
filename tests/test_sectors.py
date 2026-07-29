"""Sector rating arithmetic.

The point of these is that a rating is checkable: build a series with a
known shape, and the components must say what a chart of it would say.
"""
from __future__ import annotations

import pytest

from lib import sectors


def ramp(n: int, start: float = 100.0, step: float = 0.5) -> list[float]:
    return [start + step * i for i in range(n)]


def flat(n: int, v: float = 100.0) -> list[float]:
    return [v] * n


class TestHelpers:
    def test_sma_needs_a_full_window(self):
        assert sectors.sma(flat(49), 50) is None
        assert sectors.sma(flat(50, 7.0), 50) == 7.0

    def test_sma_uses_only_the_last_n(self):
        closes = [0.0] * 100 + [10.0] * 50
        assert sectors.sma(closes, 50) == 10.0

    def test_pct_change_refuses_a_window_it_cannot_fill(self):
        # 30 bars cannot carry a 63-bar return. Reaching for the first bar
        # instead would label a six-week move as a three-month one.
        assert sectors.pct_change(ramp(30), 63) is None

    def test_pct_change_arithmetic(self):
        assert sectors.pct_change([100, 110], 1) == pytest.approx(10.0)
        assert sectors.pct_change([100, 90], 1) == pytest.approx(-10.0)

    def test_pct_change_survives_a_zero_base(self):
        assert sectors.pct_change([0.0, 5.0], 1) is None


class TestMeasure:
    def test_reports_none_everywhere_on_an_empty_series(self):
        m = sectors.measure([])
        assert m["last"] is None and m["ma200"] is None and m["ret_1m"] is None
        assert m["bars"] == 0

    def test_a_rising_series_sits_above_both_averages(self):
        m = sectors.measure(ramp(300))
        assert m["last"] > m["ma50"] > m["ma200"]
        assert m["ret_1m"] > 0 and m["ret_3m"] > 0

    def test_relative_is_the_difference_of_two_three_month_returns(self):
        sect, bench = ramp(300, step=1.0), ramp(300, step=0.2)
        m = sectors.measure(sect, bench)
        assert m["relative_3m"] == pytest.approx(m["ret_3m"] - m["bench_3m"])
        assert m["relative_3m"] > 0

    def test_relative_is_withheld_without_a_benchmark(self):
        assert sectors.measure(ramp(300))["relative_3m"] is None

    def test_the_52_week_high_uses_the_trailing_year_only(self):
        # A spike 300 sessions ago is not part of the 52-week high.
        closes = [500.0] + flat(300, 100.0)
        m = sectors.measure(closes)
        assert m["high_52w"] == 100.0
        assert m["from_high_pct"] == pytest.approx(0.0)

    def test_from_high_is_negative_below_the_high(self):
        closes = ramp(260) + [ramp(260)[-1] * 0.9]
        assert sectors.measure(closes)["from_high_pct"] == pytest.approx(-10.0, abs=0.01)


class TestComponents:
    def test_a_strong_uptrend_scores_positive_across_the_board(self):
        c = sectors.components(sectors.measure(ramp(300, step=1.0),
                                               ramp(300, step=0.1), 0.6))
        assert c["trend"] == 1.0
        assert c["structure"] == 1.0
        assert c["relative"] > 0
        assert c["momentum"] > 0
        assert c["position"] == pytest.approx(1.0)
        assert c["breadth"] == pytest.approx(0.6)

    def test_a_downtrend_scores_negative(self):
        down = list(reversed(ramp(300, step=1.0)))
        c = sectors.components(sectors.measure(down, flat(300), -0.5))
        assert c["trend"] == -1.0
        assert c["structure"] == -1.0
        assert c["momentum"] < 0
        assert c["position"] < 0
        assert c["breadth"] == -0.5

    def test_components_saturate_rather_than_running_away(self):
        # A sector 90 points ahead of the index must not score 9.
        compounding = [100 * 1.01 ** i for i in range(300)]
        m = sectors.measure(compounding, flat(300), 12.0)
        c = sectors.components(m)
        assert c["relative"] == 1.0
        assert c["momentum"] == 1.0
        assert c["breadth"] == 1.0
        assert all(-1.0 <= v <= 1.0 for v in c.values() if v is not None)

    def test_missing_history_leaves_components_none_not_zero(self):
        c = sectors.components(sectors.measure(ramp(10)))
        assert c["trend"] is None and c["structure"] is None
        assert c["relative"] is None


class TestScore:
    def test_withholds_a_rating_when_too_little_is_measurable(self):
        out = sectors.score({"trend": 1.0, "structure": 1.0, "relative": None,
                             "momentum": None, "position": None, "breadth": None})
        assert out["score"] is None and out["rating"] is None
        assert "history" in out["reason"]

    def test_a_perfect_sector_scores_100_and_a_broken_one_minus_100(self):
        allc = {k: 1.0 for k in sectors.WEIGHTS}
        assert sectors.score(allc)["score"] == 100.0
        assert sectors.score({k: -1.0 for k in sectors.WEIGHTS})["score"] == -100.0

    def test_a_missing_component_is_dropped_not_treated_as_zero(self):
        full = {k: 1.0 for k in sectors.WEIGHTS}
        without = {**full, "breadth": None}
        # Every remaining component is maximal, so the score must stay 100 —
        # counting the absent breadth as 0 would drag it to 90.
        assert sectors.score(without)["score"] == 100.0

    def test_contributions_sum_to_the_score(self):
        out = sectors.score({"trend": 1.0, "structure": -1.0, "relative": 0.5,
                             "momentum": 0.2, "position": -0.3, "breadth": 0.0})
        assert sum(out["contributions"].values()) == pytest.approx(out["score"], abs=0.2)

    def test_bands_are_ordered_and_cover_the_whole_range(self):
        assert sectors.band(100) == "Strong bull"
        assert sectors.band(50) == "Strong bull"
        assert sectors.band(21) == "Bull"
        assert sectors.band(0) == "Neutral"
        assert sectors.band(-20) == "Neutral"
        assert sectors.band(-21) == "Bear"
        assert sectors.band(-90) == "Strong bear"


class TestBoard:
    def _fake(self, sector_step: float = 1.0):
        def history_fn(symbol, period="1Y"):
            step = 0.2 if symbol == sectors.BENCHMARK else sector_step
            return [{"close": c} for c in ramp(300, step=step)]

        def quotes_fn(syms):
            return {s: {"change_pct": 1.0} for s in syms}

        return history_fn, quotes_fn

    def test_rates_every_sector_and_sorts_best_first(self):
        board = sectors.get_sector_board(*self._fake())
        assert len(board["sectors"]) == len(sectors.SECTORS)
        assert board["rated"] == len(sectors.SECTORS)
        scores = [s["score"] for s in board["sectors"]]
        assert scores == sorted(scores, reverse=True)

    def test_breadth_counts_advancers_and_decliners(self):
        def history_fn(symbol, period="1Y"):
            return [{"close": c} for c in ramp(300)]

        def quotes_fn(syms):
            return {s: {"change_pct": (1.0 if i % 2 == 0 else -1.0)}
                    for i, s in enumerate(syms)}

        board = sectors.get_sector_board(history_fn, quotes_fn)
        row = board["sectors"][0]
        assert row["advancers"] + row["decliners"] == row["members_quoted"]
        assert row["members_quoted"] <= row["members_total"]

    def test_a_dead_provider_yields_unrated_sectors_not_fake_ones(self):
        board = sectors.get_sector_board(lambda s, p="1Y": [], lambda s: {})
        assert board["rated"] == 0
        assert all(s["score"] is None for s in board["sectors"])
        assert all(s["reason"] for s in board["sectors"])

    def test_unquotable_members_do_not_invent_breadth(self):
        def history_fn(symbol, period="1Y"):
            return [{"close": c} for c in ramp(300)]

        board = sectors.get_sector_board(history_fn, lambda syms: {s: None for s in syms})
        row = board["sectors"][0]
        assert row["members_quoted"] == 0
        assert row["components"]["breadth"] is None
        assert row["score"] is not None      # the other five still rate it

    def test_the_note_states_the_method_and_its_limits(self):
        note = sectors.get_sector_board(lambda s, p="1Y": [], lambda s: {})["note"]
        assert "trend-following" in note
        assert "not a forecast" in note.lower() or "not a" in note.lower()
