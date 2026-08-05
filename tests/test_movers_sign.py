"""Gainers and losers must actually have gained and lost.

The dashboard's Top Losers panel was showing rows with POSITIVE changes. The
ranking sorted ascending and took the first N, which on a day the whole index
rises returns the eight weakest RISERS — presented under a losers heading.
A green row there is the kind of error that makes a reader stop trusting
every other number on the screen.
"""
from lib.market_data import rank_movers


def rows(*pcts):
    return [{"symbol": f"T{i}", "change_pct": p, "turnover": 1000 - i}
            for i, p in enumerate(pcts)]


class TestSign:
    def test_every_gainer_has_a_POSITIVE_change(self):
        got = rank_movers(rows(5.0, 2.0, -1.0, -4.0), "gainers", 8)
        assert got and all(r["change_pct"] > 0 for r in got)

    def test_every_loser_has_a_NEGATIVE_change(self):
        got = rank_movers(rows(5.0, 2.0, -1.0, -4.0), "losers", 8)
        assert got and all(r["change_pct"] < 0 for r in got)

    def test_a_day_where_everything_rose_has_NO_losers(self):
        # The exact bug: eight slots, ten risers, and the ranking filled the
        # losers panel with the eight that rose least.
        got = rank_movers(rows(5.0, 4.0, 3.0, 2.0, 1.0, 0.5), "losers", 8)
        assert got == []

    def test_a_day_where_everything_fell_has_NO_gainers(self):
        assert rank_movers(rows(-5.0, -4.0, -3.0), "gainers", 8) == []

    def test_returns_fewer_rather_than_padding_with_the_wrong_side(self):
        got = rank_movers(rows(9.0, 8.0, 7.0, -0.5), "losers", 8)
        assert len(got) == 1 and got[0]["change_pct"] == -0.5


class TestOrder:
    def test_gainers_run_strongest_first(self):
        got = rank_movers(rows(1.0, 9.0, 4.0), "gainers", 8)
        assert [r["change_pct"] for r in got] == [9.0, 4.0, 1.0]

    def test_losers_run_worst_first(self):
        got = rank_movers(rows(-1.0, -9.0, -4.0), "losers", 8)
        assert [r["change_pct"] for r in got] == [-9.0, -4.0, -1.0]

    def test_respects_the_count(self):
        assert len(rank_movers(rows(*[float(i) for i in range(1, 30)]),
                               "gainers", 8)) == 8


class TestEdges:
    def test_a_FLAT_name_is_neither_a_gainer_nor_a_loser(self):
        assert rank_movers(rows(0.0), "gainers", 8) == []
        assert rank_movers(rows(0.0), "losers", 8) == []

    def test_drops_rows_with_no_change_figure(self):
        got = rank_movers([{"symbol": "A", "change_pct": None},
                           {"symbol": "B", "change_pct": -2.0}], "losers", 8)
        assert [r["symbol"] for r in got] == ["B"]

    def test_actives_rank_on_turnover_and_keep_BOTH_signs(self):
        # Sign is not part of the question for most-traded.
        got = rank_movers([{"symbol": "A", "change_pct": -5.0, "turnover": 10},
                           {"symbol": "B", "change_pct": 5.0, "turnover": 99}],
                          "actives", 8)
        assert [r["symbol"] for r in got] == ["B", "A"]

    def test_handles_an_empty_universe(self):
        assert rank_movers([], "gainers", 8) == []
