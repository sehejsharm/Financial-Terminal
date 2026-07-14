"""Screen filtering logic (pure, no network)."""
from lib.screens import apply_filters, run_preset


def _row(**kw):
    base = {
        "ticker": "X", "name": "X Ltd", "mcap_cr": 10000, "eps_growth": 25,
        "sales_growth": 20, "peg": 0.8, "de": 0.4, "roce": 22, "roe": 20,
        "promoter": 60, "pe": 18,
    }
    base.update(kw)
    return base


def test_apply_filters_and_semantics():
    rows = [_row(pe=10), _row(pe=40, ticker="Y")]
    out = apply_filters(rows, [{"key": "pe", "op": "<", "value": 20}])
    assert len(out) == 1 and out[0]["ticker"] == "X"


def test_apply_filters_missing_key_excluded():
    rows = [{"ticker": "Z"}]  # no 'pe' key
    out = apply_filters(rows, [{"key": "pe", "op": "<", "value": 20}])
    assert out == []


def test_apply_filters_multiple_and():
    rows = [_row(), _row(ticker="Y", de=2.0)]
    out = apply_filters(rows, [
        {"key": "peg", "op": "<", "value": 1},
        {"key": "de", "op": "<", "value": 1},
    ])
    assert [r["ticker"] for r in out] == ["X"]


def test_run_preset_peg():
    passing = _row()  # meets all PEG-screen thresholds
    failing = _row(ticker="Y", peg=2.0)  # PEG too high
    out = run_preset("PEG Screen", [passing, failing])
    assert [r["ticker"] for r in out] == ["X"]


# ── each preset must return a materially different set within its bounds ─────

_MEGA = _row(ticker="MEGA", mcap_cr=1_000_000)                # Reliance-scale
_MID = _row(ticker="MID", mcap_cr=3000, sales_growth=30,
            eps_growth=30, roce=25, de=0.2, promoter=60)      # Hidden-Gems fit
_SMALL_LOWGROWTH = _row(ticker="SLG", mcap_cr=800, eps_growth=5,
                        sales_growth=5, roce=8)


def test_large_cap_excludes_small_caps():
    out = run_preset("Large Cap", [_MEGA, _MID, _SMALL_LOWGROWTH])
    tickers = [r["ticker"] for r in out]
    assert "MEGA" in tickers and "MID" not in tickers and "SLG" not in tickers


def test_hidden_gems_excludes_mega_caps():
    out = run_preset("Hidden Gems", [_MEGA, _MID, _SMALL_LOWGROWTH])
    tickers = [r["ticker"] for r in out]
    # Reliance-scale names must NEVER appear in a ₹500–5000 cr screen.
    assert "MEGA" not in tickers
    assert "MID" in tickers
    assert "SLG" not in tickers  # fails growth/ROCE thresholds
    # And the result set differs from Large Cap's.
    assert set(tickers) != {r["ticker"] for r in
                            run_preset("Large Cap", [_MEGA, _MID, _SMALL_LOWGROWTH])}


def test_large_cap_value_needs_low_pe():
    cheap = _row(ticker="CHEAP", mcap_cr=60000, pe=12)
    dear = _row(ticker="DEAR", mcap_cr=60000, pe=40)
    out = run_preset("Large Cap Value", [cheap, dear])
    assert [r["ticker"] for r in out] == ["CHEAP"]


# ── ROCE must be real or absent — never a silent ROE alias ──────────────────

def test_roce_not_aliased_to_roe():
    from lib.screens import _build_metrics
    f = {"market_cap": 5e11, "name": "T", "roe": 0.18}   # no roce from provider
    m = _build_metrics("TEST.NS", f)
    assert m["roe"] == 18.0
    assert m["roce"] is None, "ROCE must not silently fall back to ROE"


def test_roce_used_when_provider_supplies_it():
    from lib.screens import _build_metrics
    f = {"market_cap": 5e11, "name": "T", "roe": 0.18, "roce": 0.11}
    m = _build_metrics("TEST.NS", f)
    assert m["roce"] == 11.0 and m["roe"] == 18.0
    assert m["roce"] != m["roe"]
