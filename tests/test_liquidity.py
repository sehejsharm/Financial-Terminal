"""Can this position actually be traded?

The point of these is that the answer is checkable arithmetic: build a bar
series with a known average daily value, ask for a known notional, and the
day count must be the number you can do on paper.
"""
from __future__ import annotations

import pytest

from lib import liquidity as lq


def bars(n: int, close: float, volume: float) -> list[dict]:
    return [{"close": close, "volume": volume} for _ in range(n)]


class TestAdv:
    def test_average_daily_VALUE_not_share_count(self):
        # 1m shares at ₹500 is ₹500m a day.
        a = lq.adv(bars(20, 500.0, 1_000_000))
        assert a["adv_value"] == pytest.approx(500_000_000)
        assert a["adv_shares"] == pytest.approx(1_000_000)

    def test_uses_only_the_trailing_window(self):
        old = bars(50, 100.0, 10_000_000)      # very liquid, long ago
        recent = bars(20, 100.0, 100_000)      # thin now
        a = lq.adv(old + recent)
        assert a["adv_value"] == pytest.approx(10_000_000)
        assert a["sessions"] == 20

    def test_reports_the_median_alongside_the_mean(self):
        # One index-rebalance day: 19 normal sessions plus a 100x day.
        series = bars(19, 100.0, 1_000) + bars(1, 100.0, 100_000)
        a = lq.adv(series)
        assert a["median_value"] == pytest.approx(100_000)
        assert a["adv_value"] > a["median_value"] * 4

    def test_ignores_zero_volume_sessions_in_the_average(self):
        a = lq.adv(bars(10, 100.0, 0) + bars(10, 100.0, 1_000))
        assert a["adv_value"] == pytest.approx(100_000)
        assert a["sessions"] == 10

    def test_returns_nothing_for_an_empty_or_broken_series(self):
        for series in ([], [{"foo": 1}], [{"close": None, "volume": 5}]):
            a = lq.adv(series)
            assert a["adv_value"] is None and a["sessions"] == 0

    def test_survives_NaN(self):
        assert lq.adv([{"close": float("nan"), "volume": 1}])["adv_value"] is None


class TestDaysToTrade:
    def test_the_arithmetic_is_what_it_says(self):
        # $1bn at 15% of a $500m ADV = 1e9 / 75e6 ≈ 13.33 sessions.
        assert lq.days_to_trade(1e9, 500e6, 0.15) == pytest.approx(13.333, rel=1e-3)

    def test_participation_scales_it_linearly(self):
        a = lq.days_to_trade(1e9, 500e6, 0.10)
        b = lq.days_to_trade(1e9, 500e6, 0.20)
        assert a == pytest.approx(b * 2)

    def test_returns_None_rather_than_infinity_for_a_dead_name(self):
        # A default here is how a position gets sized into something that
        # cannot be exited.
        assert lq.days_to_trade(1e9, None) is None
        assert lq.days_to_trade(1e9, 0) is None

    def test_refuses_nonsense_inputs(self):
        assert lq.days_to_trade(0, 500e6) is None
        assert lq.days_to_trade(1e9, 500e6, 0) is None


class TestClassify:
    def test_bands_read_left_to_right(self):
        assert lq.classify(0.5) == "same day"
        assert lq.classify(3) == "days"
        assert lq.classify(12) == "weeks"
        assert lq.classify(40) == "months"
        assert lq.classify(120) == "untradable at size"
        assert lq.classify(None) == "unknown"

    def test_the_boundaries_are_inclusive_downward(self):
        assert lq.classify(1) == "same day"
        assert lq.classify(5) == "days"
        assert lq.classify(20) == "weeks"


class TestProfile:
    def test_sizes_off_the_MEDIAN_when_a_spike_inflates_the_mean(self):
        # The mean says this is tradable; the median says it is not. Believing
        # the mean is how a thin name gets bought in size.
        spiky = bars(19, 100.0, 1_000) + bars(1, 100.0, 1_000_000)
        p = lq.profile(spiky, notional=1e7)
        assert p["basis_value"] == pytest.approx(100_000)
        assert p["days"] > 100
        assert p["verdict"] == "untradable at size"

    def test_a_deep_name_absorbs_size_in_a_checkable_number_of_days(self):
        # $1bn ADV, 15% participation -> $150m a day -> 6.7 sessions for $1bn.
        p = lq.profile(bars(20, 200.0, 5_000_000), notional=1e9)
        assert p["days"] == pytest.approx(6.67, abs=0.01)
        assert p["verdict"] == "weeks"
        # A tenth of that clears inside one session.
        assert lq.profile(bars(20, 200.0, 5_000_000), notional=1e8)["verdict"] == "same day"

    def test_an_unquoted_name_has_no_verdict_rather_than_a_good_one(self):
        p = lq.profile([], notional=1e9)
        assert p["days"] is None and p["verdict"] == "unknown"

    def test_carries_the_assumptions_it_used(self):
        p = lq.profile(bars(20, 100.0, 1e6), notional=5e8, participation=0.1)
        assert p["participation"] == 0.1
        assert p["notional"] == 5e8


class TestBook:
    def _hist(self, table):
        def history_fn(sym, period="3M"):
            return table.get(sym, [])
        return history_fn

    def test_profiles_every_name_and_summarises(self):
        table = {
            "DEEP": bars(20, 100.0, 10_000_000),     # $1bn/day
            "THIN": bars(20, 10.0, 1_000),           # $10k/day
        }
        out = lq.book(self._hist(table), ["DEEP", "THIN"], notional_each=1e8)
        assert out["names"]["DEEP"]["verdict"] in ("same day", "days")
        assert out["names"]["THIN"]["verdict"] == "untradable at size"
        assert out["summary"]["names"] == 2
        assert out["summary"]["priced"] == 2

    def test_counts_names_it_could_not_price_separately(self):
        out = lq.book(self._hist({"A": bars(20, 100.0, 1e6)}), ["A", "MISSING"],
                      notional_each=1e7)
        assert out["summary"]["priced"] == 1
        assert out["summary"]["unknown"] == 1
        assert out["names"]["MISSING"]["days"] is None

    def test_the_worst_leg_is_reported_because_it_sets_the_timeline(self):
        table = {"A": bars(20, 100.0, 10_000_000), "B": bars(20, 100.0, 100_000)}
        out = lq.book(self._hist(table), ["A", "B"], notional_each=1e8)
        assert out["summary"]["worst_days"] == out["names"]["B"]["days"]

    def test_deduplicates_and_normalises_symbols(self):
        out = lq.book(self._hist({"A": bars(20, 100.0, 1e6)}), ["a", "A", " a "],
                      notional_each=1e7)
        assert list(out["names"]) == ["A"]

    def test_a_provider_error_does_not_sink_the_basket(self):
        def history_fn(sym, period="3M"):
            if sym == "BOOM":
                raise RuntimeError("provider down")
            return bars(20, 100.0, 1e6)
        out = lq.book(history_fn, ["OK", "BOOM"], notional_each=1e7)
        assert out["names"]["OK"]["days"] is not None
        assert out["names"]["BOOM"]["days"] is None

    def test_handles_an_empty_basket(self):
        out = lq.book(self._hist({}), [], notional_each=1e9)
        assert out["names"] == {} and out["summary"]["names"] == 0

    def test_the_note_states_what_is_NOT_modelled(self):
        note = lq.book(self._hist({}), ["A"], notional_each=1e9)["note"]
        assert "impact" in note.lower()
        assert "borrow" in note.lower()
