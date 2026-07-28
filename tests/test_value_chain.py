"""Value-chain helpers + figure construction (no network)."""
import pytest
from lib.value_chain import _rgba, _trunc, build_chain_figure


def test_rgba_conversion():
    assert _rgba("#1fd286", 0.5) == "rgba(31,210,134,0.5)"
    assert _rgba("ffffff", 1) == "rgba(255,255,255,1)"


def test_trunc():
    assert _trunc("hello", 10) == "hello"
    assert _trunc("hello world", 5) == "hell…"


def test_build_figure_with_data():
    data = {
        "suppliers": [{"name": "TSMC", "note": "chips"}],
        "customers": [{"name": "Consumers", "note": "phones"}],
        "competitors": [{"name": "Samsung", "note": "phones"}],
    }
    fig = build_chain_figure("AAPL", "Apple Inc.", data)
    assert fig is not None
    assert len(fig.data) >= 1  # at least the node/edge traces


def test_build_figure_empty_data_does_not_crash():
    for d in ({}, {"suppliers": [], "customers": [], "competitors": []}):
        fig = build_chain_figure("T", "Test Co", d)
        assert fig is not None


# ── roles[] annotation (entity de-duplication support) ─────────────────────

def test_annotate_roles_marks_multi_role_entity():
    """A company appearing as both customer and competitor gets roles=[both]
    on BOTH occurrences, so the client can merge them into one node."""
    from backend.routes.value_chain import _annotate_roles
    data = _annotate_roles({
        "suppliers": [{"name": "Acme Corp"}],
        "customers": [{"name": "Samsung"}],
        "competitors": [{"name": "Samsung"}],
    })
    assert data["suppliers"][0]["roles"] == ["supplier"]
    assert data["customers"][0]["roles"] == ["customer", "competitor"]
    assert data["competitors"][0]["roles"] == ["customer", "competitor"]


def test_annotate_roles_is_suffix_and_case_insensitive():
    from backend.routes.value_chain import _annotate_roles
    data = _annotate_roles({
        "suppliers": [{"name": "Tata Motors Ltd."}],
        "customers": [],
        "competitors": [{"name": "TATA MOTORS"}],
    })
    assert data["suppliers"][0]["roles"] == ["supplier", "competitor"]


def test_annotate_roles_keeps_distinct_companies_apart():
    """Sibling companies sharing a first word must NOT be merged — a false
    merge is worse than a duplicate node in a research tool."""
    from backend.routes.value_chain import _annotate_roles
    data = _annotate_roles({
        "suppliers": [{"name": "Tata Steel"}],
        "customers": [],
        "competitors": [{"name": "Tata Motors"}],
    })
    assert data["suppliers"][0]["roles"] == ["supplier"]
    assert data["competitors"][0]["roles"] == ["competitor"]


def test_annotate_roles_preserves_positional_arrays():
    """roles[] is ADDITIVE — the three arrays stay on the wire so old pins,
    history snapshots, CSV exports and admin overrides keep working."""
    from backend.routes.value_chain import _annotate_roles
    src = {"suppliers": [{"name": "A", "revenue_pct": 5}],
           "customers": [{"name": "B"}], "competitors": []}
    out = _annotate_roles(src)
    assert [n["name"] for n in out["suppliers"]] == ["A"]
    assert out["suppliers"][0]["revenue_pct"] == 5
    assert [n["name"] for n in out["customers"]] == ["B"]


def test_norm_entity_matches_frontend_rules():
    from backend.routes.value_chain import _norm_entity
    assert _norm_entity("Apple Inc.") == _norm_entity("APPLE")
    assert _norm_entity("Reliance Industries Limited") == _norm_entity("Reliance Industries")
    assert _norm_entity("Tata Motors") != _norm_entity("Tata Steel")
    assert _norm_entity("Ltd") != ""     # never collapse to empty


# ── categorised reports + aggregate counts ────────────────────────────────

def test_report_categories_closed_set():
    """Unknown categories degrade to 'unspecified' rather than polluting the
    review queue with arbitrary strings."""
    from backend.routes.value_chain import REPORT_CATEGORIES
    assert "wrong_entity" in REPORT_CATEGORIES
    assert "wrong_weight" in REPORT_CATEGORIES
    assert "outdated" in REPORT_CATEGORIES
    assert "duplicate" in REPORT_CATEGORIES
    assert "other" in REPORT_CATEGORIES


def test_report_count_aggregation(tmp_path, monkeypatch):
    """Counts aggregate per NORMALISED entity so flags against 'Samsung' and
    'Samsung Electronics Ltd' land on the same merged node."""
    import json as _json
    from backend.routes import value_chain as vc_routes

    path = tmp_path / "vc_reports.jsonl"
    rows = [
        {"ticker": "AAPL", "node_name": "Samsung", "role": "customer",
         "category": "wrong_weight"},
        {"ticker": "AAPL", "node_name": "Samsung Electronics Ltd", "role": "competitor",
         "category": "duplicate"},
        {"ticker": "AAPL", "node_name": "Bosch", "role": "supplier"},   # no category
        {"ticker": "MSFT", "node_name": "Samsung", "role": "customer",
         "category": "outdated"},                                       # other ticker
    ]
    path.write_text("\n".join(_json.dumps(r) for r in rows) + "\n")
    monkeypatch.setattr(vc_routes, "REPORTS_PATH", path)

    out = vc_routes.report_counts("aapl", _user={"username": "t"})
    counts = out["counts"]
    samsung = counts[vc_routes._norm_entity("Samsung")]
    assert samsung["count"] == 2                       # both spellings merged
    assert samsung["categories"]["wrong_weight"] == 1
    assert samsung["categories"]["duplicate"] == 1
    assert sorted(samsung["roles"]) == ["competitor", "customer"]
    # A single flag still records, but the UI only badges at >1.
    assert counts[vc_routes._norm_entity("Bosch")]["count"] == 1
    # Other tickers are excluded.
    assert sum(c["count"] for c in counts.values()) == 3


def test_report_counts_missing_file_is_empty(tmp_path, monkeypatch):
    from backend.routes import value_chain as vc_routes
    monkeypatch.setattr(vc_routes, "REPORTS_PATH", tmp_path / "nope.jsonl")
    assert vc_routes.report_counts("AAPL", _user={"username": "t"})["counts"] == {}


# ── contagion path finder (aggregate graph over every generated map) ───────

def _seed_history(tmp_path, monkeypatch, maps):
    """Write a fake vc_history.jsonl and point the route at it."""
    import json as _json
    from backend.routes import value_chain as vc_routes
    path = tmp_path / "vc_history.jsonl"
    lines = []
    for ticker, name, sup, cus in maps:
        lines.append(_json.dumps({
            "ticker": ticker, "generated_at": "2026-01-01T00:00:00",
            "data": {"name": name,
                     "suppliers": [{"name": n} for n in sup],
                     "customers": [{"name": n} for n in cus],
                     "competitors": []},
        }))
    path.write_text("\n".join(lines) + "\n")
    monkeypatch.setattr(vc_routes, "HISTORY_PATH", path)
    monkeypatch.setattr(vc_routes, "_GRAPH_CACHE", None)
    return vc_routes


def test_contagion_direct_link(tmp_path, monkeypatch):
    vc_routes = _seed_history(tmp_path, monkeypatch, [
        ("NVDA", "Nvidia", ["TSMC"], ["Microsoft"]),
    ])
    out = vc_routes.contagion_path(source="Nvidia", target="TSMC",
                                   _user={"username": "t"})
    assert out["found"] is True
    assert out["degrees"] == 1
    assert out["hops"][0]["to"] == "TSMC"


def test_contagion_multi_hop_across_separate_maps(tmp_path, monkeypatch):
    """The whole point: two companies that never appear in the SAME map are
    still connected through the aggregate graph."""
    vc_routes = _seed_history(tmp_path, monkeypatch, [
        ("NVDA", "Nvidia", ["TSMC"], []),
        ("TSM", "TSMC", ["Shin-Etsu Chemical"], []),
        ("RELIANCE.NS", "Reliance Industries", ["Shin-Etsu Chemical"], []),
    ])
    out = vc_routes.contagion_path(source="Nvidia", target="Reliance Industries",
                                   _user={"username": "t"})
    assert out["found"] is True
    # Nvidia -> TSMC -> Shin-Etsu -> Reliance
    assert out["degrees"] == 3
    assert "TSMC" in out["nodes"]
    assert "Shin-Etsu Chemical" in out["nodes"]


def test_contagion_traverses_both_directions(tmp_path, monkeypatch):
    """Contagion travels upstream AND downstream, so the graph is undirected."""
    vc_routes = _seed_history(tmp_path, monkeypatch, [
        ("A", "Alpha", ["Bravo"], []),
    ])
    out = vc_routes.contagion_path(source="Bravo", target="Alpha",
                                   _user={"username": "t"})
    assert out["found"] is True and out["degrees"] == 1


def test_contagion_reports_no_path_rather_than_inventing_one(tmp_path, monkeypatch):
    vc_routes = _seed_history(tmp_path, monkeypatch, [
        ("A", "Alpha", ["Bravo"], []),
        ("C", "Charlie", ["Delta"], []),
    ])
    out = vc_routes.contagion_path(source="Alpha", target="Charlie",
                                   _user={"username": "t"})
    assert out["found"] is False
    assert out["hops"] == []


def test_contagion_unknown_company_is_a_clear_404(tmp_path, monkeypatch):
    from fastapi import HTTPException
    vc_routes = _seed_history(tmp_path, monkeypatch, [("A", "Alpha", ["Bravo"], [])])
    with pytest.raises(HTTPException) as ei:
        vc_routes.contagion_path(source="Nonexistent Co", target="Alpha",
                                 _user={"username": "t"})
    assert ei.value.status_code == 404


def test_contagion_respects_hop_limit(tmp_path, monkeypatch):
    vc_routes = _seed_history(tmp_path, monkeypatch, [
        ("A", "Alpha", ["Bravo"], []),
        ("B", "Bravo", ["Charlie"], []),
        ("C", "Charlie", ["Delta"], []),
    ])
    assert vc_routes.contagion_path(source="Alpha", target="Delta", max_hops=1,
                                    _user={"username": "t"})["found"] is False
    assert vc_routes.contagion_path(source="Alpha", target="Delta", max_hops=6,
                                    _user={"username": "t"})["found"] is True


def test_graph_stats_counts_the_aggregate(tmp_path, monkeypatch):
    vc_routes = _seed_history(tmp_path, monkeypatch, [
        ("A", "Alpha", ["Bravo", "Charlie"], []),
    ])
    st = vc_routes.graph_stats(_user={"username": "t"})
    assert st["companies"] == 3          # Alpha + 2 suppliers
    assert st["connections"] == 2
