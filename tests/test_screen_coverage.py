"""Why the PEG, Hidden Gems and Growth presets returned nothing.

All three filter on growth, ROCE, PEG and promoter holding. No free
non-Indian provider carries any of them for NSE names, so `_ge(None, x)` was
False on every row and the presets could never match a single company. They
were not empty screens; they were screens that could not run — and an empty
table cannot tell the two apart.
"""
from lib import screens


def row(**over):
    base = {"ticker": "X", "mcap_cr": 20000, "pe": 22.0, "peg": 0.8,
            "eps_growth": 25.0, "sales_growth": 18.0, "roce": 20.0,
            "de": 0.3, "promoter": 60.0}
    base.update(over)
    return base


class TestPegDerivation:
    def test_derives_PEG_from_P_E_and_growth_when_the_provider_omits_it(self):
        # Providers rarely populate PEG for NSE names even with both inputs
        # present, and it gates two of the three broken presets.
        m = screens._build_metrics("X.NS", {
            "market_cap": 1e11, "trailing_pe": 20, "earnings_growth": 0.25})
        assert m["peg"] == 0.8

    def test_prefers_the_provider_s_own_PEG(self):
        m = screens._build_metrics("X.NS", {
            "market_cap": 1e11, "trailing_pe": 20, "earnings_growth": 0.25,
            "peg": 1.7})
        assert m["peg"] == 1.7

    def test_REFUSES_a_PEG_on_negative_growth(self):
        # A negative PEG sorts as "cheap" and is meaningless.
        m = screens._build_metrics("X.NS", {
            "market_cap": 1e11, "trailing_pe": 20, "earnings_growth": -0.25})
        assert m["peg"] is None

    def test_no_PEG_without_growth(self):
        m = screens._build_metrics("X.NS", {"market_cap": 1e11, "trailing_pe": 20})
        assert m["peg"] is None


class TestCoverage:
    def test_names_the_field_that_makes_a_preset_unrunnable(self):
        rows = [row(promoter=None) for _ in range(20)]
        assert screens.unrunnable_fields(rows, "Hidden Gems") == ["promoter"]

    def test_says_nothing_when_every_field_is_evaluable_somewhere(self):
        rows = [row() for _ in range(5)]
        assert screens.unrunnable_fields(rows, "Growth") == []

    def test_one_populated_row_is_enough_to_make_a_field_runnable(self):
        # The screen can then genuinely return nothing, which is a finding.
        rows = [row(promoter=None) for _ in range(19)] + [row(promoter=61.0)]
        assert screens.unrunnable_fields(rows, "Hidden Gems") == []

    def test_counts_coverage_per_field(self):
        rows = [row(roce=None), row(), row()]
        cov = screens.field_coverage(rows, ("roce", "de"))
        assert cov == {"roce": 2, "de": 3}

    def test_has_nothing_to_report_on_an_empty_scan(self):
        assert screens.unrunnable_fields([], "Growth") == []

    def test_every_preset_declares_what_it_needs(self):
        # A preset with no declared requirements would silently skip the
        # coverage check and go back to returning unexplained emptiness.
        assert set(screens.PRESET_REQUIRES) == set(screens.PRESETS)

    def test_declared_requirements_are_real_fields(self):
        keys = {f["key"] for f in screens.FIELDS}
        for name, req in screens.PRESET_REQUIRES.items():
            assert set(req) <= keys, name


class TestPresetsRunWhenTheFieldsExist:
    def test_the_three_broken_presets_match_a_qualifying_company(self):
        # The point of the fix: given the fields, these screens work.
        qualifying = row(mcap_cr=8000, eps_growth=30.0, sales_growth=28.0,
                         peg=0.7, roce=22.0, de=0.2, promoter=62.0)
        for name in ("PEG Screen", "Growth"):
            assert screens.run_preset(name, [qualifying]), name

    def test_hidden_gems_respects_its_market_cap_band(self):
        small = row(mcap_cr=2000, eps_growth=30.0, sales_growth=28.0,
                    roce=22.0, de=0.2, promoter=62.0)
        assert screens.run_preset("Hidden Gems", [small])
        # A large cap is not a hidden gem however good its numbers.
        assert not screens.run_preset("Hidden Gems", [{**small, "mcap_cr": 90000}])

    def test_a_missing_field_still_excludes_that_row(self):
        # Enrichment fills what it can; it must not invent what it cannot.
        assert not screens.run_preset("Growth", [row(promoter=None)])


class TestEnrichIndian:
    def test_fills_growth_and_promoter_from_NSE(self, monkeypatch):
        parsed = {
            "columns": ["2024-06-30", "2024-09-30", "2024-12-31",
                        "2025-03-31", "2025-06-30"],
            "rows": [
                {"line": "Revenue", "2024-06-30": 100.0, "2024-09-30": 105.0,
                 "2024-12-31": 110.0, "2025-03-31": 115.0, "2025-06-30": 125.0},
                {"line": "Net Income", "2024-06-30": 10.0, "2024-09-30": 11.0,
                 "2024-12-31": 12.0, "2025-03-31": 13.0, "2025-06-30": 14.0},
            ],
        }
        monkeypatch.setattr("lib.nse_financials.financial_results",
                            lambda *a, **k: parsed)
        monkeypatch.setattr("lib.nse_financials.promoter_holding",
                            lambda *a, **k: 58.5)
        out = screens.enrich_indian("RELIANCE.NS", {"market_cap": 1e12})
        # Fractions, matching every other provider field in this pipeline.
        assert abs(out["revenue_growth"] - 0.25) < 1e-9
        assert abs(out["earnings_growth"] - 0.40) < 1e-9
        assert abs(out["held_insiders"] - 0.585) < 1e-9

    def test_never_overwrites_a_value_the_provider_already_had(self, monkeypatch):
        monkeypatch.setattr("lib.nse_financials.financial_results",
                            lambda *a, **k: {"columns": [], "rows": []})
        monkeypatch.setattr("lib.nse_financials.promoter_holding",
                            lambda *a, **k: 58.5)
        out = screens.enrich_indian("X.NS", {"held_insiders": 0.42})
        assert out["held_insiders"] == 0.42

    def test_survives_NSE_being_unreachable(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("blocked")
        monkeypatch.setattr("lib.nse_financials.financial_results", boom)
        monkeypatch.setattr("lib.nse_financials.promoter_holding", boom)
        out = screens.enrich_indian("X.NS", {"market_cap": 1e11})
        assert out["market_cap"] == 1e11
