"""Value-chain helpers + figure construction (no network)."""
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
