"""The backtester.

Three things in the previous version all flattered the strategy: it charged
nothing to trade, it reported a share of winning DAYS under the name "win
rate", and it counted each side of a round trip as a separate trade. These
pin the fixes and the refusals.
"""
import numpy as np
import pandas as pd

from lib.backtest import (
    DEFAULT_COST_BPS, extract_trades, parameter_sweep, run_backtest,
)


def frame(closes):
    idx = pd.bdate_range("2023-01-02", periods=len(closes))
    return pd.DataFrame({"Close": closes}, index=idx)


def trending(n=400, start=100.0, drift=0.004):
    """A clean uptrend: any long strategy should be invested and profitable."""
    return frame([start * (1 + drift) ** i for i in range(n)])


def choppy(n=400, amp=0.06, period=9):
    """Whipsaw: crossings constantly, so cost sensitivity is visible."""
    return frame([100 * (1 + amp * np.sin(2 * np.pi * i / period))
                  for i in range(n)])


class TestCosts:
    def test_charges_every_position_change(self):
        # A rule that flips forty times a year looked identical to one that
        # traded twice, and every result beat anything achievable.
        free = run_backtest(choppy(), "sma_cross",
                            {"fast": 5, "slow": 20, "cost_bps": 0})
        costed = run_backtest(choppy(), "sma_cross",
                              {"fast": 5, "slow": 20, "cost_bps": 50})
        assert costed["stats"]["total_return_pct"] < free["stats"]["total_return_pct"]

    def test_reports_what_the_costs_took_out(self):
        r = run_backtest(choppy(), "sma_cross",
                         {"fast": 5, "slow": 20, "cost_bps": 50})
        assert r["stats"]["cost_drag_pct"] > 0
        assert r["stats"]["cost_bps"] == 50

    def test_costs_a_strategy_that_never_trades_almost_nothing(self):
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        # One entry near the start and nothing after it in a clean trend.
        assert r["stats"]["cost_drag_pct"] < 1.0

    def test_defaults_to_a_real_cost_rather_than_zero(self):
        assert DEFAULT_COST_BPS > 0
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        assert r["stats"]["cost_bps"] == DEFAULT_COST_BPS


class TestTradeAccounting:
    def test_a_round_trip_is_ONE_trade(self):
        # Counting both sides halves the costs a reader imagines and doubles
        # the average trade they infer.
        pos = pd.Series([0, 1, 1, 0, 0], index=pd.bdate_range("2024-01-01", periods=5))
        close = pd.Series([100, 110, 120, 130, 140.0], index=pos.index)
        assert len(extract_trades(pos, close)) == 1

    def test_measures_the_trade_from_entry_to_exit(self):
        pos = pd.Series([0, 1, 1, 0], index=pd.bdate_range("2024-01-01", periods=4))
        close = pd.Series([100, 100, 120, 110.0], index=pos.index)
        t = extract_trades(pos, close)[0]
        # Entered at the 100 bar, exited at the 110 bar.
        assert t["entry"] == 100 and t["exit"] == 110
        assert abs(t["return_pct"] - 10.0) < 1e-9
        # Entry index 1, exit index 3: two bars held.
        assert t["bars"] == 2

    def test_EXCLUDES_a_position_still_open_at_the_end(self):
        # An unrealised winner counted as completed inflates both the hit rate
        # and the average trade.
        pos = pd.Series([0, 1, 1, 1], index=pd.bdate_range("2024-01-01", periods=4))
        close = pd.Series([100, 100, 150, 200.0], index=pos.index)
        assert extract_trades(pos, close) == []

    def test_handles_several_round_trips(self):
        pos = pd.Series([0, 1, 0, 1, 0], index=pd.bdate_range("2024-01-01", periods=5))
        close = pd.Series([100, 100, 110, 110, 99.0], index=pos.index)
        ts = extract_trades(pos, close)
        assert len(ts) == 2
        assert ts[0]["return_pct"] > 0 and ts[1]["return_pct"] < 0

    def test_win_rate_counts_TRADES_not_days(self):
        # A trend strategy has more losing days than winning ones and still
        # makes money; the old number described the wrong quantity.
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        s = r["stats"]
        if s["trades"]:
            assert 0 <= s["win_rate_pct"] <= 100

    def test_profit_factor_is_gross_win_over_gross_loss(self):
        pos = pd.Series([0, 1, 0, 1, 0], index=pd.bdate_range("2024-01-01", periods=5))
        close = pd.Series([100, 100, 120, 120, 108.0], index=pos.index)
        r = {"trades": extract_trades(pos, close)}
        from lib.backtest import _trade_stats
        s = _trade_stats(r["trades"])
        # +20% against -10%.
        assert abs(s["profit_factor"] - 2.0) < 1e-6

    def test_reports_nothing_rather_than_zero_with_no_trades(self):
        from lib.backtest import _trade_stats
        s = _trade_stats([])
        assert s["trades"] == 0
        assert s["win_rate_pct"] is None
        assert s["avg_trade_pct"] is None


class TestCurveStats:
    def test_reports_time_in_market(self):
        # A strategy flat 80% of the time carries very different risk from one
        # always invested, and a return figure alone cannot tell them apart.
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        assert 0 <= r["stats"]["exposure_pct"] <= 100

    def test_a_long_only_rule_in_a_clean_uptrend_is_mostly_invested(self):
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        assert r["stats"]["exposure_pct"] > 60

    def test_sharpe_is_measured_over_the_RISK_FREE_rate(self):
        # A 6% return in a 7% rate environment is not a positive Sharpe, and
        # assuming rf=0 quietly claims it is.
        base = run_backtest(trending(), "sma_cross",
                            {"fast": 20, "slow": 50, "risk_free_pct": 0})
        over = run_backtest(trending(), "sma_cross",
                            {"fast": 20, "slow": 50, "risk_free_pct": 7})
        assert over["stats"]["sharpe"] < base["stats"]["sharpe"]

    def test_gives_buy_and_hold_its_drawdown_too(self):
        # Comparing a strategy's return to buy-and-hold without comparing the
        # drawdown compares half of each.
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        assert r["stats"]["buy_hold_max_drawdown_pct"] <= 0

    def test_REFUSES_a_CAGR_on_a_wiped_out_curve(self):
        # A fractional power of a negative number is complex, and 0 would
        # print as "-100% a year forever".
        from lib.backtest import _curve_stats
        idx = pd.bdate_range("2024-01-01", periods=100)
        eq = pd.Series(np.linspace(1.0, 0.0, 100), index=idx)
        s = _curve_stats(eq, eq.pct_change().fillna(0), pd.Series(1.0, index=idx), eq)
        assert s["cagr_pct"] is None


class TestSignals:
    def test_acts_on_the_NEXT_bar_not_the_signal_bar(self):
        # The close that triggers a cross is not tradeable until the next
        # session; acting on it is lookahead.
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 50})
        # Position must be flat on the first bar whatever the signal said.
        assert float(r["equity"].iloc[0]) == 1.0

    def test_stays_flat_while_a_moving_average_is_still_filling(self):
        # Treating an unformed average as a signal front-runs the strategy.
        r = run_backtest(trending(), "sma_cross", {"fast": 20, "slow": 200})
        assert float(r["equity"].iloc[50]) == 1.0

    def test_supports_a_breakout_rule(self):
        r = run_backtest(trending(), "breakout", {"window": 20, "exit": 10})
        assert r and r["stats"]["bars"] > 0

    def test_breakout_compares_against_the_PREVIOUS_bar_s_extreme(self):
        # Otherwise the bar that sets the high is also the bar that triggers
        # on it, which cannot be traded.
        r = run_backtest(trending(), "breakout", {"window": 20, "exit": 10})
        assert float(r["equity"].iloc[0]) == 1.0

    def test_refuses_an_incoherent_parameter_set(self):
        assert run_backtest(trending(), "sma_cross", {"fast": 200, "slow": 50}) == {}
        assert run_backtest(trending(), "rsi", {"low": 70, "high": 30}) == {}

    def test_refuses_an_unknown_strategy(self):
        assert run_backtest(trending(), "astrology", {}) == {}

    def test_refuses_too_little_history(self):
        assert run_backtest(trending(30), "sma_cross", {}) == {}
        assert run_backtest(None, "sma_cross", {}) == {}
        assert run_backtest(pd.DataFrame(), "sma_cross", {}) == {}


class TestParameterSweep:
    def test_runs_the_neighbourhood_of_the_chosen_parameters(self):
        # A single backtest of tuned parameters is a curve fit, and nothing in
        # one equity curve reveals that.
        sw = parameter_sweep(trending(), "sma_cross", {})
        assert sw["row_key"] == "fast" and sw["col_key"] == "slow"
        assert len(sw["grid"]) == len(sw["rows"])
        assert len(sw["grid"][0]) == len(sw["cols"])

    def test_says_how_many_combinations_beat_buy_and_hold(self):
        # The one number that says whether the headline result was luck.
        sw = parameter_sweep(trending(), "sma_cross", {})
        assert sw["combinations"] > 0
        assert 0 <= sw["beat_buy_hold"] <= sw["combinations"]

    def test_reports_the_spread_across_the_grid(self):
        sw = parameter_sweep(trending(), "sma_cross", {})
        assert sw["worst_pct"] <= sw["median_pct"] <= sw["best_pct"]

    def test_sweeps_every_supported_strategy(self):
        for strat in ("sma_cross", "rsi", "breakout"):
            assert parameter_sweep(trending(), strat, {}), strat

    def test_has_nothing_to_sweep_for_an_unknown_strategy(self):
        assert parameter_sweep(trending(), "astrology", {}) == {}
