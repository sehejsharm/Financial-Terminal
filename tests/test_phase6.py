"""Phase 6 backend logic: alert evaluation, sentiment parsing, storage docs."""
import pandas as pd

from backend.routes.ai import parse_sentiment_labels
from backend.routes import alerts as alerts_mod


def test_parse_sentiment_labels_happy():
    raw = 'Here you go: ["bull", "neutral", "bear"]'
    assert parse_sentiment_labels(raw, 3) == ["bull", "neutral", "bear"]


def test_parse_sentiment_labels_bad_count_or_shape():
    assert parse_sentiment_labels('["bull"]', 3) is None
    assert parse_sentiment_labels("no json here", 2) is None


def test_parse_sentiment_labels_normalizes_unknown():
    assert parse_sentiment_labels('["BULL", "meh", "bear"]', 3) == \
        ["bull", "neutral", "bear"]


def test_alert_trigger_logic(monkeypatch, tmp_path):
    from backend import storage as storage_mod
    monkeypatch.setattr(storage_mod, "_storage", storage_mod.JSONStore(tmp_path))

    store = storage_mod.get_storage()
    store.save_user_doc("alerts", "sehej", {"alerts": [
        {"id": "1", "kind": "price", "ticker": "X.NS", "op": "<",
         "value": 100.0, "active": True},
        {"id": "2", "kind": "price", "ticker": "X.NS", "op": ">",
         "value": 100.0, "active": True},
    ], "events": []})

    monkeypatch.setattr(alerts_mod.providers, "quote",
                        lambda t: {"price": 90.0})
    fired = alerts_mod.evaluate_all()
    assert fired == 1  # only the "< 100" alert fires at price 90

    doc = store.user_doc("alerts", "sehej")
    a1 = next(a for a in doc["alerts"] if a["id"] == "1")
    a2 = next(a for a in doc["alerts"] if a["id"] == "2")
    assert a1["active"] is False and a1["triggered_at"]
    assert a2["active"] is True
    assert len(doc["events"]) == 1 and "crossed" in doc["events"][0]["message"]

    # A second pass must not re-fire the deactivated alert.
    assert alerts_mod.evaluate_all() == 0


def test_deals_aggregate_grouping(monkeypatch):
    from backend.routes import deals as deals_mod
    df = pd.DataFrame({
        "Date": ["10-Jul-2026", "11-Jul-2026", "11-Jul-2026"],
        "Symbol": ["ABC", "ABC", "XYZ"],
        "Client Name": ["Fund A", "Fund B", "Fund A"],
        "Buy/Sell": ["BUY", "SELL", "BUY"],
        "Quantity Traded": [1000, 400, 50],
        "Trade Price / Wght. Avg. Price": [10.0, 12.0, 100.0],
    })
    monkeypatch.setattr(deals_mod, "get_bulk_deals", lambda: df)
    out = deals_mod.aggregate.__wrapped__(kind="bulk", days=30, _user=None)
    rows = {r["symbol"]: r for r in out["rows"]}
    assert rows["ABC"]["buy_qty"] == 1000 and rows["ABC"]["sell_qty"] == 400
    assert rows["ABC"]["net_qty"] == 600
    assert rows["ABC"]["participants"] == 2
    assert rows["XYZ"]["net_qty"] == 50
    assert out["from"] == "2026-07-10" and out["to"] == "2026-07-11"


def test_storage_user_docs_roundtrip(tmp_path):
    from backend.storage import JSONStore
    s = JSONStore(tmp_path)
    assert s.user_doc("portfolios", "u", {"positions": []}) == {"positions": []}
    s.save_user_doc("portfolios", "u", {"positions": [{"id": "1"}]})
    assert s.user_doc("portfolios", "u")["positions"][0]["id"] == "1"
    assert "u" in s.all_user_docs("portfolios")
