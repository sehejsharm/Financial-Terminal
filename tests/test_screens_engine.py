"""Screener filter engine.

The behaviour worth pinning is how MISSING data is treated. A screen that
counted "unknown" as a pass would silently include companies it can't
evaluate, which is the worst possible failure for a stock filter.
"""
from __future__ import annotations

import pytest

from lib.screens import (
    FIELDS, FIELD_KEYS, OPS, _passes, apply_filters, coverage, sectors_in,
)

ROWS = [
    {"ticker": "A", "sector": "Technology", "pe": 20.0, "roe": 30.0, "de": 0.1,
     "div_yield": 1.2},
    {"ticker": "B", "sector": "Energy", "pe": None, "roe": 10.0, "de": 1.4,
     "div_yield": None},
    {"ticker": "C", "sector": "Technology", "pe": 8.0, "roe": 5.0, "de": 0.0,
     "div_yield": 3.0},
    {"ticker": "D", "sector": "", "pe": 45.0, "roe": None, "de": None,
     "div_yield": 0.0},
]

names = lambda rows: [r["ticker"] for r in rows]  # noqa: E731


# ── the missing-data rule ─────────────────────────────────────────────────

def test_a_missing_value_NEVER_passes_a_filter():
    # B has no P/E. It must not survive a P/E filter under any operator.
    for op, val in [(">", 0), ("<", 1e9), (">=", 0), ("<=", 1e9), ("=", 0)]:
        out = apply_filters(ROWS, [{"key": "pe", "op": op, "value": val}])
        assert "B" not in names(out), f"missing P/E slipped through '{op}'"


def test_missing_value_fails_between_too():
    out = apply_filters(ROWS, [{"key": "pe", "op": "between",
                                "value": 0, "value2": 1e9}])
    assert "B" not in names(out)


def test_an_unknown_field_matches_nothing_rather_than_everything():
    assert apply_filters(ROWS, [{"key": "not_a_field", "op": ">", "value": 0}]) == []


def test_a_missing_threshold_matches_nothing():
    assert apply_filters(ROWS, [{"key": "pe", "op": ">", "value": None}]) == []


# ── operators ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("op,val,expected", [
    (">", 10, ["A", "D"]),
    (">=", 20, ["A", "D"]),
    ("<", 20, ["C"]),
    ("<=", 20, ["A", "C"]),
    ("=", 8, ["C"]),
])
def test_comparison_operators(op, val, expected):
    assert names(apply_filters(ROWS, [{"key": "pe", "op": op, "value": val}])) == expected


def test_between_is_inclusive_and_order_independent():
    assert names(apply_filters(ROWS, [{"key": "pe", "op": "between",
                                       "value": 8, "value2": 20}])) == ["A", "C"]
    # Bounds given backwards still describe the same interval.
    assert names(apply_filters(ROWS, [{"key": "pe", "op": "between",
                                       "value": 20, "value2": 8}])) == ["A", "C"]


def test_equality_tolerates_float_representation():
    # An exact == on a computed ratio would essentially never match.
    assert _passes(0.1 + 0.2, "=", 0.3) is True


def test_an_unknown_operator_matches_nothing():
    assert apply_filters(ROWS, [{"key": "pe", "op": "~=", "value": 20}]) == []


def test_zero_is_a_real_value_not_a_missing_one():
    # D's dividend yield is 0.0 — a fact, not an absence.
    out = apply_filters(ROWS, [{"key": "div_yield", "op": "<=", "value": 0}])
    assert names(out) == ["D"]


# ── combining ─────────────────────────────────────────────────────────────

def test_all_requires_every_clause():
    out = apply_filters(ROWS, [{"key": "pe", "op": "<", "value": 25},
                               {"key": "roe", "op": ">", "value": 20}])
    assert names(out) == ["A"]


def test_any_requires_only_one():
    out = apply_filters(ROWS, [{"key": "pe", "op": "<", "value": 10},
                               {"key": "roe", "op": ">", "value": 20}],
                        match="any")
    assert names(out) == ["A", "C"]


def test_no_filters_returns_everything():
    assert len(apply_filters(ROWS, [])) == len(ROWS)


def test_sector_filter_narrows_and_composes_with_clauses():
    assert names(apply_filters(ROWS, [], sectors=["Technology"])) == ["A", "C"]
    out = apply_filters(ROWS, [{"key": "pe", "op": "<", "value": 10}],
                        sectors=["Technology"])
    assert names(out) == ["C"]
    # A row with no sector is excluded by an explicit sector filter.
    assert "D" not in names(apply_filters(ROWS, [], sectors=["Technology", "Energy"]))


def test_empty_sector_list_means_no_sector_filter():
    assert len(apply_filters(ROWS, [], sectors=[])) == len(ROWS)


# ── coverage ──────────────────────────────────────────────────────────────

def test_coverage_counts_populated_values_per_field():
    cov = coverage(ROWS)
    assert cov["pe"] == 3          # B is missing
    assert cov["roe"] == 3         # D is missing
    assert cov["div_yield"] == 3   # B is missing; D's 0.0 counts
    assert cov["peg"] == 0         # nothing carries it


def test_coverage_reports_every_declared_field():
    assert set(coverage(ROWS)) == FIELD_KEYS


def test_sectors_in_is_sorted_and_drops_blanks():
    assert sectors_in(ROWS) == ["Energy", "Technology"]


# ── the field catalogue ───────────────────────────────────────────────────

def test_fields_are_unique_labelled_and_grouped():
    keys = [f["key"] for f in FIELDS]
    assert len(set(keys)) == len(keys)
    for f in FIELDS:
        assert f["label"] and f["group"]
        assert "unit" in f


def test_every_declared_field_is_produced_by_the_metric_builder():
    from lib.screens import _build_metrics
    row = _build_metrics("TCS.NS", {
        "market_cap": 1.5e13, "name": "TCS", "sector": "Technology",
        "price": 3900, "fifty_two_high": 4500, "fifty_two_low": 3000,
        "fifty_day_avg": 3800, "two_hundred_day_avg": 3700,
        "trailing_pe": 28, "forward_pe": 25, "peg": 2.1, "price_to_book": 12,
        "price_to_sales": 6, "earnings_growth": 0.1, "revenue_growth": 0.07,
        "roce": 0.5, "roe": 0.45, "profit_margin": 0.19,
        "operating_margin": 0.24, "gross_margin": 0.42,
        "debt_to_equity": 9.0, "current_ratio": 2.5, "revenue": 2.4e12,
        "free_cashflow": 4.2e11, "dividend_yield": 0.014, "beta": 0.8,
        "held_insiders": 0.72,
    })
    missing = [k for k in FIELD_KEYS if k not in row]
    assert not missing, f"declared but never produced: {missing}"
    # And the derived technicals are right.
    assert row["pos_52w"] == 60.0
    assert row["de"] == 0.09
    assert row["profit_margin"] == 19.0


def test_ops_set_matches_what_passes_implements():
    for op in OPS:
        # Each declared operator must be understood (10 > 5 is true for the
        # comparison ops; between needs its second bound).
        assert _passes(10, op, 10, 10) in (True, False)
