"""Graham valuation + Buffett checklist (pure logic, no network)."""
from lib.value_investing import (
    buffett_checklist,
    graham_intrinsic_value,
    margin_of_safety,
)


def test_graham_value_basic():
    # V = EPS x (8.5 + 2g) x 4.4 / Y, g clamped to [0, 30]
    v = graham_intrinsic_value(10.0, 10.0, 7.0)
    expected = 10.0 * (8.5 + 2 * 10.0) * 4.4 / 7.0
    assert abs(v - expected) < 1e-6


def test_graham_value_growth_clamped():
    # growth above 30 is clamped to 30
    v_high = graham_intrinsic_value(5.0, 99.0, 7.0)
    v_cap = graham_intrinsic_value(5.0, 30.0, 7.0)
    assert abs(v_high - v_cap) < 1e-6


def test_graham_value_invalid_eps():
    assert graham_intrinsic_value(0, 10, 7) is None
    assert graham_intrinsic_value(-5, 10, 7) is None
    assert graham_intrinsic_value(10, 10, 0) is None


def test_margin_of_safety():
    assert margin_of_safety(100, 80) == 20.0      # 20% below intrinsic
    assert margin_of_safety(100, 120) == -20.0    # overvalued
    assert margin_of_safety(None, 80) is None
    assert margin_of_safety(100, None) is None


def test_buffett_checklist_shape():
    f = {
        "profit_margin": 0.15, "operating_margin": 0.20, "roe": 0.18,
        "roa": 0.10, "debt_to_equity": 40, "trailing_pe": 18, "peg": 0.9,
        "free_cashflow": 1e9, "revenue_growth": 0.12,
    }
    items, summary = buffett_checklist(f, intrinsic=100, price=70)
    assert isinstance(items, list) and len(items) > 0
    for key in ("pass", "warn", "fail", "score", "scored"):
        assert key in summary
    assert 0 <= summary["score"] <= 100
    assert summary["scored"] == summary["pass"] + summary["warn"] + summary["fail"]


def test_buffett_handles_missing_data():
    items, summary = buffett_checklist({}, None, None)
    # Everything n/a should not crash and score stays in range.
    assert 0 <= summary["score"] <= 100
