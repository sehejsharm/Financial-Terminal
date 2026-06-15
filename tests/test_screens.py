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
