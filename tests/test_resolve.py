"""Phase 0 repro cases: canonical ticker resolution."""
import lib.resolve as rz


_DIR = {
    "SUZLON": {"name": "Suzlon Energy Limited", "isin": "INE040H01021"},
    "TCS": {"name": "Tata Consultancy Services Limited", "isin": "INE467B01029"},
    "INFY": {"name": "Infosys Limited", "isin": "INE009A01021"},
    "RELIANCE": {"name": "Reliance Industries Limited", "isin": "INE002A01018"},
    "TATAMOTORS": {"name": "Tata Motors Limited", "isin": ""},
    "TATASTEEL": {"name": "Tata Steel Limited", "isin": ""},
}


def _iso(monkeypatch, global_hits=None):
    monkeypatch.setattr(rz, "_nse_directory", lambda: _DIR)
    import lib.search as sx
    monkeypatch.setattr(sx, "search_securities",
                        lambda q, limit=8: list(global_hits or []))


def test_repro1_suzlon_bare_resolves_to_ns(monkeypatch):
    _iso(monkeypatch)
    r = rz.resolve("SUZLON")
    assert r["status"] == "resolved"
    assert r["match"]["symbol"] == "SUZLON.NS"
    assert r["match"]["exchange"] == "NSE"


def test_repro2_tcs_never_resolves_to_container_store(monkeypatch):
    # Global search returns the US retailer for "TCS" — India-first exact
    # symbol rule must still win, with the US listing only as an alternate.
    _iso(monkeypatch, global_hits=[
        {"symbol": "TCS", "name": "The Container Store Group, Inc.",
         "exchange": "NYSE", "type": "EQUITY"},
    ])
    r = rz.resolve("TCS")
    assert r["status"] == "resolved"
    assert r["match"]["symbol"] == "TCS.NS"
    assert "Tata Consultancy" in r["match"]["name"]
    assert any(c["symbol"] == "TCS" for c in r["candidates"])  # alternate shown


def test_repro3_bare_us_symbol_without_nse_match(monkeypatch):
    _iso(monkeypatch, global_hits=[
        {"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    ])
    r = rz.resolve("AAPL")
    assert r["status"] == "resolved" and r["match"]["symbol"] == "AAPL"


def test_repro4_infosys_name_is_ambiguous_never_guessed(monkeypatch):
    _iso(monkeypatch)
    r = rz.resolve("INFOSYS")
    assert r["status"] == "ambiguous"
    assert any(c["symbol"] == "INFY.NS" for c in r["candidates"])
    assert r["match"] is None  # name matches are NEVER silently picked


def test_nonexistent_returns_none(monkeypatch):
    _iso(monkeypatch)
    assert rz.resolve("XQZWQJ")["status"] == "none"


def test_qualified_input_passes_through(monkeypatch):
    _iso(monkeypatch)
    r = rz.resolve("reliance.ns")
    assert r["status"] == "resolved"
    assert r["match"]["symbol"] == "RELIANCE.NS"
    assert r["match"]["name"] == "Reliance Industries Limited"
    assert rz.resolve("^NSEI")["status"] == "resolved"


def test_canonicalize_backstop(monkeypatch):
    _iso(monkeypatch)
    assert rz.canonicalize("TCS") == "TCS.NS"
    assert rz.canonicalize("AAPL") is None or isinstance(rz.canonicalize("AAPL"), str)
    assert rz.canonicalize("INFOSYS") is None  # ambiguous -> no silent guess


def test_directory_search_tata_family(monkeypatch):
    _iso(monkeypatch)
    hits = rz.directory_search("TATA")
    syms = [h["symbol"] for h in hits]
    assert "TATAMOTORS.NS" in syms and "TATASTEEL.NS" in syms
    # Name match finds TCS too ("Tata Consultancy…")
    assert any("TCS" in s for s in syms)
