"""NSE results parsing.

The feed is a filing summary, not a statements API: numbers arrive as strings,
in lakhs or crores depending on what the company declared, with keys that
differ between consolidated and standalone filings. These pin the parsing, and
in particular the refusals — a wrong revenue figure is worse than a missing
one, because it looks exactly like a real one.
"""
from lib.nse_financials import (
    financial_results, latest_period, parse_results, series, trailing_twelve,
    yoy_growth,
)


def filing(to_date, **over):
    """One NSE result row, in the shape the feed returns."""
    base = {
        "re_to_date": to_date,
        "re_unit": "Lakhs",
        "re_consolidated": "Consolidated",
        "re_net_sal": "970000",          # 9.7 lakh crore in lakhs
        "re_pro_bfr_tax": "151000",
        "re_tax": "38000",
        "re_pro_aft_tax": "113000",
        "re_basic_eps_for_cont_dic_optd": "17.4",
    }
    base.update(over)
    return base


QUARTERS = [
    filing("30-Jun-2025", re_net_sal="1050000", re_pro_aft_tax="125000",
           re_basic_eps_for_cont_dic_optd="19.1"),
    filing("31-Mar-2025", re_net_sal="1010000", re_pro_aft_tax="118000"),
    filing("31-Dec-2024", re_net_sal="990000", re_pro_aft_tax="115000"),
    filing("30-Sep-2024", re_net_sal="975000", re_pro_aft_tax="112000"),
    filing("30-Jun-2024", re_net_sal="950000", re_pro_aft_tax="105000",
           re_basic_eps_for_cont_dic_optd="16.0"),
]


class TestParse:
    def test_columns_are_period_ends_oldest_first(self):
        # The feed returns newest first; the statement screens read left to
        # right as time, and a reversed series gives growth the wrong sign.
        p = parse_results(QUARTERS)
        assert p["columns"] == ["2024-06-30", "2024-09-30", "2024-12-31",
                                "2025-03-31", "2025-06-30"]
        assert p["columns"] == sorted(p["columns"])

    def test_applies_the_filing_s_own_unit_scale(self):
        # 1,050,000 lakhs is ₹10.5 lakh crore, not ₹10.5 lakh.
        p = parse_results(QUARTERS)
        assert series(p, "Revenue")[-1] == 1050000 * 1e5

    def test_reads_crores_when_the_filing_says_crores(self):
        p = parse_results([filing("30-Jun-2025", re_unit="Crores", re_net_sal="10500")])
        assert series(p, "Revenue")[0] == 10500 * 1e7

    def test_does_NOT_scale_per_share_figures(self):
        # An EPS multiplied by the lakh scale reads as millions per share.
        p = parse_results(QUARTERS)
        assert series(p, "EPS (basic)")[-1] == 19.1

    def test_prefers_the_consolidated_filing_for_a_period(self):
        rows = [
            filing("30-Jun-2025", re_consolidated="Standalone", re_net_sal="10"),
            filing("30-Jun-2025", re_consolidated="Consolidated", re_net_sal="99"),
        ]
        assert series(parse_results(rows), "Revenue")[0] == 99 * 1e5

    def test_keeps_a_standalone_only_period_rather_than_leaving_a_gap(self):
        rows = [filing("30-Jun-2025", re_consolidated="Standalone", re_net_sal="10")]
        assert series(parse_results(rows), "Revenue") == [10 * 1e5]

    def test_parses_the_date_formats_the_feed_actually_uses(self):
        for raw, want in (("30-Jun-2025", "2025-06-30"),
                          ("2025-06-30", "2025-06-30"),
                          ("30-06-2025", "2025-06-30")):
            assert parse_results([filing(raw)])["columns"] == [want]

    def test_drops_a_row_with_no_usable_period(self):
        assert parse_results([filing("not a date")])["columns"] == []

    def test_reads_numbers_the_feed_sends_as_strings(self):
        p = parse_results([filing("30-Jun-2025", re_net_sal="1,050,000")])
        assert series(p, "Revenue")[0] == 1050000 * 1e5

    def test_treats_a_dash_as_missing_rather_than_zero(self):
        # NSE uses "-" for a line the company didn't report. Zero revenue and
        # unreported revenue are very different claims.
        p = parse_results([filing("30-Jun-2025", re_oth_inc="-")])
        assert series(p, "Other income") == []

    def test_omits_a_line_no_filing_reported(self):
        p = parse_results(QUARTERS)
        assert all(r["line"] != "Depreciation" for r in p["rows"])

    def test_handles_an_empty_or_junk_feed(self):
        for rows in ([], [None], ["nonsense"], [{}]):
            p = parse_results(rows)
            assert p == {"columns": [], "rows": []}


class TestDerived:
    def test_latest_period_is_the_newest_column(self):
        assert latest_period(parse_results(QUARTERS)) == "2025-06-30"

    def test_trailing_twelve_sums_the_last_four_quarters(self):
        p = parse_results(QUARTERS)
        want = (1050000 + 1010000 + 990000 + 975000) * 1e5
        assert trailing_twelve(p, "Revenue") == want

    def test_trailing_twelve_REFUSES_a_partial_year(self):
        # Three quarters annualised as four overstates by a third and looks
        # exactly like a real figure.
        p = parse_results(QUARTERS[:3])
        assert trailing_twelve(p, "Revenue") is None

    def test_yoy_compares_the_SAME_quarter_a_year_earlier(self):
        # Indian results are seasonal; Q1 against Q4 measures the calendar.
        p = parse_results(QUARTERS)
        got = yoy_growth(p, "Revenue")
        assert got is not None
        assert abs(got - ((1050000 - 950000) / 950000 * 100)) < 1e-9

    def test_yoy_needs_a_full_year_of_history(self):
        assert yoy_growth(parse_results(QUARTERS[:4]), "Revenue") is None

    def test_yoy_REFUSES_a_sign_flip(self):
        # -10 to +5 is not 150% growth, it is a company that stopped losing
        # money, and a percentage cannot express that.
        rows = [filing(d, re_pro_aft_tax=v) for d, v in (
            ("30-Jun-2024", "-10000"), ("30-Sep-2024", "-8000"),
            ("31-Dec-2024", "-5000"), ("31-Mar-2025", "1000"),
            ("30-Jun-2025", "5000"))]
        assert yoy_growth(parse_results(rows), "Net Income") is None

    def test_series_of_an_absent_line_is_empty(self):
        assert series(parse_results(QUARTERS), "Nonexistent") == []


class TestFetch:
    def test_returns_the_empty_shape_when_nse_is_unreachable(self, monkeypatch):
        # The caller falls through to its other providers; a screen saying
        # "no data" beats one that 500s.
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: None)
        assert financial_results("RELIANCE.NS") == {"columns": [], "rows": []}

    def test_refuses_a_symbol_it_cannot_clean(self, monkeypatch):
        monkeypatch.setattr("lib.nse._get",
                            lambda *a, **k: (_ for _ in ()).throw(AssertionError("called")))
        assert financial_results("^NSEI") == {"columns": [], "rows": []}

    def test_accepts_both_envelope_shapes(self, monkeypatch):
        # The endpoint has returned a bare list and a {data: [...]} envelope.
        for payload in (QUARTERS, {"data": QUARTERS}):
            monkeypatch.setattr("lib.nse._get", lambda *a, **k: payload)
            assert len(financial_results("RELIANCE.NS")["columns"]) == 5
