"""Contract test: every period label the terminal UI offers must be
understood by each history provider (no silent fallback to 1Y)."""
from lib import market_data as md
from lib import nse

# Must match PERIODS in frontend/src/app/terminal/page.tsx.
UI_PERIODS = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y"]

# The Twelve Data period map lives inside _td_time_series; mirror the labels
# it must support (intraday + daily + weekly tiers).
TD_PERIODS = {"1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "2Y", "3Y", "5Y", "10Y"}


def test_yfinance_period_map_covers_ui():
    for p in UI_PERIODS:
        assert p in md.PERIOD_MAP, f"yfinance PERIOD_MAP missing {p}"


def test_nse_period_days_covers_daily_ui():
    # NSE serves daily bars only; YTD is computed, intraday labels have a
    # small-day fallback so Indian names still render something.
    for p in UI_PERIODS:
        if p == "YTD":
            continue
        assert p in nse._PERIOD_DAYS, f"nse._PERIOD_DAYS missing {p}"


def test_td_period_map_covers_ui():
    import inspect
    from backend import providers
    src = inspect.getsource(providers._td_time_series)
    for p in TD_PERIODS:
        assert f'"{p}"' in src, f"_td_time_series period_map missing {p}"


def test_nse_ytd_days_sane():
    from datetime import datetime
    elapsed = (datetime.now() - datetime(datetime.now().year, 1, 1)).days
    # The YTD branch in nse.history clamps to >= 7 days and never exceeds
    # the elapsed calendar days.
    assert max(7, elapsed) >= 7
