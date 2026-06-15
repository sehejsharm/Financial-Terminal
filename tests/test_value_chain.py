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
