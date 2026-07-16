"""Dashboard index tiles: comma-string parsing + name matching (Midcap/500 bug)."""
from lib import nse


def test_safe_float_handles_nse_comma_strings():
    assert nse._safe_float("59,461.20") == 59461.20
    assert nse._safe_float("1,23,456.78") == 123456.78  # Indian grouping too
    assert nse._safe_float(24211.0) == 24211.0
    assert nse._safe_float("-") is None
    assert nse._safe_float(None) is None
    assert nse._safe_float("garbage") is None


_FIXTURE = {"data": [
    {"index": "NIFTY 50", "indexSymbol": "NIFTY 50",
     "last": "24,211.00", "previousClose": "24,206.90", "percentChange": 0.02},
    {"index": "NIFTY MIDCAP 100", "indexSymbol": "NIFTY MIDCAP 100",
     "last": "59,461.20", "previousClose": "59,000.10", "percentChange": 0.78},
    {"index": "NIFTY 500", "indexSymbol": "NIFTY 500",
     "last": "22,111.55", "previousClose": "22,001.00", "percentChange": 0.51},
]}


def test_index_quote_midcap_and_500_resolve(monkeypatch):
    monkeypatch.setattr(nse, "_get", lambda *a, **k: _FIXTURE)
    q = nse.index_quote("^CNXMIDCAP")
    assert q and q["price"] == 59461.20 and q["change_pct"] == 0.78
    q = nse.index_quote("^CNX500")
    assert q and q["price"] == 22111.55


def test_index_quote_matches_indexsymbol_field(monkeypatch):
    # Name lives only in indexSymbol (API revisions have moved it around).
    fixture = {"data": [{"index": "", "indexSymbol": "NIFTY MIDCAP 100",
                         "last": 59461.2, "previousClose": 59000.1,
                         "percentChange": 0.78}]}
    monkeypatch.setattr(nse, "_get", lambda *a, **k: fixture)
    q = nse.index_quote("^CNXMIDCAP")
    assert q and q["price"] == 59461.2
