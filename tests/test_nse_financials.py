"""NSE results -> income statement.

The previous version of this module read /api/corporates-financial-results and
looked for line items among its keys. A probe against RELIANCE.NS from a host
with real NSE access returned filing metadata only — companyName, isin,
fromDate, xbrl, and so on — and all twelve lines came back unmapped because
there was nothing in that response to map. These pin the corrected path: the
XBRL document the index row links to.
"""
from pathlib import Path

import pytest

from lib import nse_financials as nf
from lib.nse_financials import (
    build_statement, consistency, extract_lines, financial_results,
    latest_period, periods_from_document, probe, series, trailing_twelve,
    yoy_growth,
)
from lib.nse_xbrl import facts_by_context, parse_document

FIXTURE = Path(__file__).parent / "fixtures" / "nse_results_q3.xml"
XML = FIXTURE.read_text()
STANDALONE_XML = (Path(__file__).parent / "fixtures"
                  / "nse_results_q3_standalone.xml").read_text()

# What the announcement index actually returns — the keys from the real probe
# run, with no financial figures anywhere in it.
INDEX_ROW = {
    "companyName": "Reliance Industries Limited",
    "symbol": "RELIANCE", "isin": "INE002A01018",
    "financialYear": "01-Apr-2024 To 31-Mar-2025",
    "period": "Quarterly", "relatingTo": "Third Quarter",
    "fromDate": "01-Oct-2024", "toDate": "31-Dec-2024",
    "audited": "Un-Audited", "consolidated": "Consolidated",
    "resultDetailedDataLink": None,
    "xbrl": "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_117298_1.xml",
    "params": "01-Oct-202431-Dec-2024Q3UNNNNERELIANCE",
}


@pytest.fixture(autouse=True)
def _clear_cache():
    nf._DOC_CACHE.clear()
    yield
    nf._DOC_CACHE.clear()


@pytest.fixture
def wired(monkeypatch):
    """The whole path: index row -> XBRL URL -> parsed document."""
    monkeypatch.setattr("lib.nse._get", lambda *a, **k: [INDEX_ROW])
    monkeypatch.setattr("lib.nse.get_text", lambda url, **k: XML)


@pytest.fixture(scope="module")
def q3_lines():
    doc = parse_document(XML)
    facts = facts_by_context(doc["facts"])["Q3FY25"]
    lines = extract_lines(facts)
    nf._derive(lines, facts)
    return lines


class TestLineMapping:
    def test_maps_every_line_the_filing_reports(self, q3_lines):
        unmapped = [k for k, v in q3_lines.items() if v["value"] is None]
        # Exceptional items is filed nil in this quarter, which means "not
        # reported" — the one legitimate absence.
        assert unmapped == ["Exceptional items"]

    def test_revenue_is_the_group_figure_in_absolute_rupees(self, q3_lines):
        # ₹2.43 trillion for the quarter. A lakh- or crore-scaled parse lands
        # this five or seven orders of magnitude out.
        assert q3_lines["Revenue"]["value"] == 2432730000000
        assert 1e11 < q3_lines["Revenue"]["value"] < 1e13

    def test_prefers_the_total_over_its_own_components(self, q3_lines):
        # `DeferredTaxExpense` sits next to `TaxExpense` in the filing and
        # matches the same words; taking it would understate tax fivefold.
        assert q3_lines["Tax Provision"]["tag"] == "TaxExpense"
        assert q3_lines["Tax Provision"]["value"] == 66220000000

    def test_ignores_a_discontinued_operations_line(self, q3_lines):
        assert q3_lines["Net Income"]["tag"] == "ProfitLossForPeriod"

    def test_does_not_scale_a_per_share_figure(self, q3_lines):
        assert q3_lines["EPS (basic)"]["value"] == 14.43
        assert q3_lines["EPS (diluted)"]["value"] == 14.41

    def test_derives_operating_income_when_the_filing_omits_it(self, q3_lines):
        # PBIDT is rarely tagged; it is PBT with interest and depreciation
        # added back, and it is labelled derived so it is never shown as filed.
        assert q3_lines["Operating Income"]["via"] == "derived"
        assert q3_lines["Operating Income"]["value"] == (
            264710000000 + 62800000000 + 134020000000)

    def test_a_tag_can_only_feed_ONE_line(self, q3_lines):
        used = [v["tag"] for v in q3_lines.values()
                if v["tag"] and v["via"] in ("exact", "fuzzy")]
        assert len(used) == len(set(used))

    def test_finds_a_line_under_a_tag_spelled_differently(self):
        # The exact names here are still a guess; the fuzzy fallback is what
        # keeps a wrong guess from silently returning nothing.
        lines = extract_lines({
            "TotalRevenueFromOperations": {"value": 5.0, "unit_ref": "INR"},
            "NetProfitLossForThePeriod": {"value": 1.0, "unit_ref": "INR"},
        })
        assert lines["Revenue"]["value"] == 5.0
        assert lines["Revenue"]["via"] == "fuzzy"
        assert lines["Net Income"]["value"] == 1.0

    def test_leaves_a_line_unmapped_rather_than_guessing(self):
        lines = extract_lines({"SomeUnrelatedDisclosure": {"value": 1.0}})
        assert lines["Revenue"]["value"] is None


class TestPeriods:
    def test_extracts_the_quarter_and_its_comparative(self):
        got = periods_from_document(parse_document(XML), "quarter")
        assert sorted(got) == ["2023-12-31", "2024-12-31"]

    def test_EXCLUDES_the_nine_month_cumulative(self):
        # ₹7.05T of nine-month revenue in a quarterly column is a threefold
        # overstatement that looks exactly like a real number.
        got = periods_from_document(parse_document(XML), "quarter")
        for lines in got.values():
            assert lines["Revenue"]["value"] != 7050000000000

    def test_EXCLUDES_a_segment_only_context(self):
        got = periods_from_document(parse_document(XML), "quarter")
        assert got["2024-12-31"]["Revenue"]["value"] == 2432730000000

    def test_reads_the_annual_shape_when_asked(self):
        got = periods_from_document(parse_document(XML), "year")
        assert list(got) == ["2024-03-31"]


class TestStatement:
    def test_columns_are_period_ends_oldest_first(self, wired):
        p = financial_results("RELIANCE.NS")
        assert p["columns"] == ["2023-12-31", "2024-12-31"]

    def test_carries_the_figures_through_to_the_rows(self, wired):
        p = financial_results("RELIANCE.NS")
        assert series(p, "Revenue") == [2255350000000, 2432730000000]
        assert latest_period(p) == "2024-12-31"

    def test_omits_a_line_no_period_reported(self):
        assert build_statement({"2024-12-31": extract_lines({})}) == {
            "columns": [], "rows": []}

    def test_follows_the_detail_link_when_nse_populates_it(self, monkeypatch):
        seen = {}
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: [
            {**INDEX_ROW, "resultDetailedDataLink": "/corporate/detail.xml"}])

        def _text(url, **k):
            seen["url"] = url
            return XML
        monkeypatch.setattr("lib.nse.get_text", _text)
        financial_results("RELIANCE.NS")
        assert seen["url"] == "https://www.nseindia.com/corporate/detail.xml"

    def test_returns_the_empty_shape_when_nse_is_unreachable(self, monkeypatch):
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: None)
        assert financial_results("RELIANCE.NS") == {"columns": [], "rows": []}

    def test_returns_the_empty_shape_when_the_document_will_not_fetch(self, monkeypatch):
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: [INDEX_ROW])
        monkeypatch.setattr("lib.nse.get_text", lambda url, **k: None)
        assert financial_results("RELIANCE.NS") == {"columns": [], "rows": []}

    def test_refuses_a_symbol_it_cannot_clean(self, monkeypatch):
        monkeypatch.setattr(
            "lib.nse._get",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("called")))
        assert financial_results("^NSEI") == {"columns": [], "rows": []}

    def test_fetches_each_document_once(self, monkeypatch):
        calls = []
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: [INDEX_ROW])
        monkeypatch.setattr("lib.nse.get_text",
                            lambda url, **k: (calls.append(url), XML)[1])
        financial_results("RELIANCE.NS")
        financial_results("RELIANCE.NS")
        assert len(calls) == 1


class TestConsolidation:
    """A group's profit does not go straight from pre-tax to net. Equity-
    accounted associates come in and the minority slice goes out, and leaving
    both out is what made the reconciliation an approximation."""

    def test_pulls_the_share_of_associates(self, q3_lines):
        assert q3_lines["Share of associates"]["value"] == 3200000000

    def test_pulls_the_minority_slice(self, q3_lines):
        assert q3_lines["Non-controlling interests"]["value"] == 3200000000

    def test_keeps_group_profit_and_owners_profit_APART(self, q3_lines):
        # The filing tags both. Letting one line claim the other is what makes
        # the minority deduction vanish into a rounding-looking gap.
        assert q3_lines["Net Income"]["tag"] == "ProfitLossForPeriod"
        assert q3_lines["Net Income"]["value"] == 198490000000
        assert q3_lines["Net Income (owners)"]["tag"] == \
            "ProfitLossAttributableToOwnersOfParent"
        assert q3_lines["Net Income (owners)"]["value"] == 195290000000

    def test_group_profit_never_claims_an_attributable_tag(self):
        # Only the parent-owners figure is tagged. Net Income must stay empty
        # rather than quietly reporting it as the group total.
        lines = extract_lines({
            "ProfitLossAttributableToOwnersOfParent": {"value": 100.0}})
        assert lines["Net Income"]["value"] is None
        assert lines["Net Income (owners)"]["value"] == 100.0


class TestConsistency:
    """The identities a real income statement satisfies. This is what makes a
    mapping checkable without knowing the company's true figures."""

    def test_a_correct_mapping_satisfies_every_identity(self, q3_lines):
        got = consistency(q3_lines)
        assert [c for c in got if c["status"] == "MISMATCH"] == []

    def test_every_identity_is_EXACT_not_approximate(self, q3_lines):
        # The point of the fix: these reconcile to the rounding the filer
        # applied, not to a tolerance wide enough to hide a missing line.
        for c in consistency(q3_lines):
            if c["status"] == "ok" and "residual" in c:
                assert c["off_by_pct"] < 0.01, c["check"]

    def test_the_profit_chain_accounts_for_associates_and_minority(self, q3_lines):
        got = {c["check"]: c for c in consistency(q3_lines)}
        pre_tax = next(c for k, c in got.items() if k.startswith("total income"))
        assert "share of associates" in pre_tax["formula"]
        assert pre_tax["residual"] == 0
        minority = next(c for k, c in got.items() if "minority" in k)
        assert minority["status"] == "ok"
        assert minority["residual"] == 0

    def test_EPS_is_struck_on_owners_profit_not_group_profit(self, q3_lines):
        # Dividing GROUP profit by EPS overstates the share count by exactly
        # the minority slice — the ~0.6% that read as "close enough".
        shares = next(c for c in consistency(q3_lines) if "share count" in c["check"])
        assert shares["numerator"] == "owners' profit"
        assert abs(shares["got"] - 195290000000 / 14.43) < 1
        # Using the group figure instead would have been visibly different.
        assert abs(shares["got"] - 198490000000 / 14.43) > 1e8

    def test_catches_a_line_mapped_to_the_wrong_tag(self, q3_lines):
        broken = {**q3_lines, "Other income": {"value": 999999999999,
                                               "tag": "X", "via": "fuzzy"}}
        got = consistency(broken)
        assert any(c["status"] == "MISMATCH" for c in got)

    def test_a_missing_line_item_does_NOT_hide_inside_the_tolerance(self, q3_lines):
        # A 1% error is far larger than filer rounding and must be caught;
        # the old 5% tolerance would have passed it.
        broken = {**q3_lines,
                  "Total expenditure": {"value": 2226570000000 * 1.01,
                                        "tag": "X", "via": "exact"}}
        pre_tax = next(c for c in consistency(broken)
                       if c["check"].startswith("total income"))
        assert pre_tax["status"] == "MISMATCH"

    def test_the_share_count_check_catches_a_scale_error(self, q3_lines):
        # Currency lines a hundred thousand times too small against an
        # unscaled EPS: every identity above still balances, and only the
        # implied share count reveals it.
        scaled = {k: ({**v, "value": v["value"] / 1e5}
                      if v["value"] is not None and not k.startswith("EPS") else v)
                  for k, v in q3_lines.items()}
        shares = next(c for c in consistency(scaled) if "share count" in c["check"])
        assert shares["status"] == "MISMATCH"

    def test_solves_for_the_sign_a_filer_used(self, q3_lines):
        # Exceptional items are filed as a positive charge by some companies
        # and a negative one by others. Fixing the sign would fail perfectly
        # good filings, so whichever balances is reported.
        for sign in (1, -1):
            lines = {**q3_lines,
                     "Total expenditure": {"value": 2226570000000 - sign * 5e9,
                                           "tag": "E", "via": "exact"},
                     "Exceptional items": {"value": sign * 5e9,
                                           "tag": "X", "via": "exact"}}
            got = next(c for c in consistency(lines)
                       if c["check"].startswith("total income"))
            assert got["status"] == "ok", sign

    def test_a_standalone_filing_SKIPS_the_minority_identity(self):
        doc = parse_document(STANDALONE_XML)
        facts = facts_by_context(doc["facts"])["Q3FY25"]
        lines = extract_lines(facts)
        nf._derive(lines, facts)
        got = {c["check"]: c for c in consistency(lines, basis="standalone")}
        minority = next(c for k, c in got.items() if "minority" in k)
        assert minority["status"] == "skipped"
        assert "standalone" in minority["reason"]
        # Everything else still has to hold.
        assert [c for c in got.values() if c["status"] == "MISMATCH"] == []

    def test_skips_a_check_whose_inputs_are_missing(self):
        got = consistency(extract_lines({}))
        assert all(c["status"] == "skipped" for c in got)


class TestDerived:
    def test_trailing_twelve_REFUSES_a_partial_year(self, wired):
        assert trailing_twelve(financial_results("RELIANCE.NS"), "Revenue") is None

    def test_trailing_twelve_REFUSES_a_per_share_line(self):
        p = {"columns": list("abcd"),
             "rows": [{"line": "EPS (basic)", "a": 1, "b": 2, "c": 3, "d": 4}]}
        # Four quarterly EPS figures summed is not an annual EPS.
        assert trailing_twelve(p, "EPS (basic)") is None

    def test_trailing_twelve_sums_four_CONSECUTIVE_quarters(self):
        cols = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"]
        p = {"columns": cols,
             "rows": [{"line": "Revenue", **dict(zip(cols, [1.0, 2.0, 3.0, 4.0]))}]}
        assert trailing_twelve(p, "Revenue") == 10.0

    def test_trailing_twelve_REFUSES_four_quarters_that_are_not_a_year(self):
        # The series built from filings is sparse: one document gives a
        # quarter and its year-ago comparative and nothing between. Four
        # available columns can be Q3 of four different years, and summing
        # those reports four years of revenue as one.
        cols = ["2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31"]
        p = {"columns": cols,
             "rows": [{"line": "Revenue", **dict(zip(cols, [1.0, 2.0, 3.0, 4.0]))}]}
        assert trailing_twelve(p, "Revenue") is None

    def test_yoy_compares_the_SAME_quarter_a_year_earlier(self):
        cols = ["2023-12-31", "2024-03-31", "2024-06-30", "2024-09-30",
                "2024-12-31"]
        p = {"columns": cols,
             "rows": [{"line": "Revenue", **dict(zip(cols, [100.0, 110, 120, 130, 150]))}]}
        assert abs(yoy_growth(p, "Revenue") - 50.0) < 1e-9

    def test_yoy_works_on_the_SPARSE_pair_one_filing_gives(self, wired):
        # A single XBRL document carries exactly the quarter and its year-ago
        # comparative. Counting four columns back finds nothing there; the
        # comparison has to be located by date.
        p = financial_results("RELIANCE.NS")
        assert p["columns"] == ["2023-12-31", "2024-12-31"]
        got = yoy_growth(p, "Revenue")
        assert abs(got - ((2432730000000 - 2255350000000) / 2255350000000 * 100)) < 1e-9

    def test_yoy_REFUSES_a_gap_that_is_not_a_year(self):
        cols = ["2022-12-31", "2024-12-31"]
        p = {"columns": cols,
             "rows": [{"line": "Revenue", **dict(zip(cols, [100.0, 150.0]))}]}
        assert yoy_growth(p, "Revenue") is None

    def test_yoy_REFUSES_a_sign_flip(self):
        cols = ["2023-12-31", "2024-12-31"]
        p = {"columns": cols,
             "rows": [{"line": "Net Income", **dict(zip(cols, [-10.0, 5.0]))}]}
        assert yoy_growth(p, "Net Income") is None

    def test_series_of_an_absent_line_is_empty(self, wired):
        assert series(financial_results("RELIANCE.NS"), "Nonexistent") == []


CONS_ROW = {**INDEX_ROW, "consolidated": "Consolidated",
            "xbrl": "https://nsearchives.nseindia.com/corporate/xbrl/C.xml"}
STAND_ROW = {**INDEX_ROW, "consolidated": "Non-Consolidated",
             "xbrl": "https://nsearchives.nseindia.com/corporate/xbrl/S.xml"}


@pytest.fixture
def both_bases(monkeypatch):
    """The same quarter filed twice, group and parent."""
    monkeypatch.setattr("lib.nse._get", lambda *a, **k: [CONS_ROW, STAND_ROW])
    monkeypatch.setattr(
        "lib.nse.get_text",
        lambda url, **k: STANDALONE_XML if url.endswith("S.xml") else XML)


class TestPrimarySelection:
    """A company files each quarter twice. Reading one basis for one quarter
    and the other for the next reports a collapse in revenue that never
    happened."""

    def test_reads_the_basis_off_the_index_row(self):
        assert nf.filing_basis({"consolidated": "Consolidated"}) == "consolidated"
        # "Non-Consolidated" contains "Consolidated"; a substring test calls
        # it the wrong thing, which is why the leading token decides.
        assert nf.filing_basis({"consolidated": "Non-Consolidated"}) == "standalone"
        assert nf.filing_basis({"consolidated": "Standalone"}) == "standalone"
        assert nf.filing_basis({}) is None

    def test_prefers_consolidated_by_default(self):
        assert nf.preferred_basis("RELIANCE.NS") == "consolidated"
        assert nf.mark_primary([CONS_ROW, STAND_ROW], "consolidated") == [True, False]
        # Order in the feed must not decide it.
        assert nf.mark_primary([STAND_ROW, CONS_ROW], "consolidated") == [False, True]

    def test_prefers_standalone_for_a_bank(self):
        # A bank's consolidated accounts fold in insurance and asset
        # management, whose economics have little to do with lending.
        assert nf.preferred_basis("HDFCBANK.NS") == "standalone"
        assert nf.mark_primary([CONS_ROW, STAND_ROW], "standalone") == [False, True]

    def test_does_NOT_prefer_standalone_for_a_holding_company(self):
        # Bajaj Finserv standalone is close to an empty shell; preferring it
        # would report almost nothing as the whole company.
        assert nf.preferred_basis("BAJAJFINSV.NS") == "consolidated"

    def test_a_period_filed_on_ONE_basis_only_is_still_primary(self):
        assert nf.mark_primary([STAND_ROW], "consolidated") == [True]

    def test_marks_one_primary_per_period(self):
        older = {**CONS_ROW, "fromDate": "01-Jul-2024", "toDate": "30-Sep-2024"}
        flags = nf.mark_primary([CONS_ROW, STAND_ROW, older], "consolidated")
        assert flags == [True, False, True]

    def test_the_statement_uses_ONLY_the_primary_basis(self, both_bases):
        p = financial_results("RELIANCE.NS")
        # The group figure, not the parent's third of it.
        assert series(p, "Revenue")[-1] == 2432730000000

    def test_an_override_switches_the_statement_basis(self, both_bases):
        p = financial_results("RELIANCE.NS", prefer="standalone")
        assert series(p, "Revenue")[-1] == 1355400000000

    def test_the_fetch_budget_counts_only_primary_filings(self, both_bases):
        calls = []
        import lib.nse as _nse
        real = _nse.get_text
        nf._DOC_CACHE.clear()

        def spy(url, **k):
            calls.append(url)
            return real(url, **k)
        _nse.get_text = spy
        try:
            financial_results("RELIANCE.NS", max_docs=1)
        finally:
            _nse.get_text = real
        # One budgeted fetch, spent on the consolidated filing, not wasted on
        # the standalone duplicate of the same quarter.
        assert calls == [CONS_ROW["xbrl"]]


class TestProbe:
    def test_reports_the_mapping_and_the_identities(self, wired):
        r = probe("RELIANCE.NS")
        assert r["ok"] is True
        d = r["documents"][0]
        assert d["unmapped_lines"] == []
        # Filed nil this quarter — an expected absence, kept out of the field
        # that means "a tag we could not find".
        assert d["optional_absent"] == ["Exceptional items"]
        assert d["source_field"] == "xbrl"
        assert d["context_used"]["end"] == "2024-12-31"
        rev = next(m for m in d["mapping"] if m["line"] == "Revenue")
        assert rev["value"] == 2432730000000
        assert [c for c in d["consistency"] if c["status"] == "MISMATCH"] == []

    def test_lists_every_tag_in_the_period_so_a_wrong_guess_is_fixable(self, wired):
        # The point of the endpoint: if a tag name here is still wrong, this
        # list is the answer, and no further guessing is needed.
        tags = [f["tag"] for f in probe("RELIANCE.NS")["documents"][0]
                ["all_numeric_facts"]]
        assert "RevenueFromOperations" in tags
        assert "DeferredTaxExpense" in tags

    def test_names_the_periods_the_document_contains(self, wired):
        avail = probe("RELIANCE.NS")["documents"][0]["contexts_available"]
        assert any("nine_month" in a for a in avail)
        assert any("quarter: 2024-10-01..2024-12-31" in a for a in avail)

    def test_reports_an_unreachable_document_honestly(self, monkeypatch):
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: [INDEX_ROW])
        monkeypatch.setattr("lib.nse.get_text", lambda url, **k: None)
        r = probe("RELIANCE.NS")
        assert r["ok"] is False
        assert "could not fetch" in r["documents"][0]["error"]

    def test_reports_an_html_error_page_as_a_parse_failure(self, monkeypatch):
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: [INDEX_ROW])
        monkeypatch.setattr("lib.nse.get_text",
                            lambda url, **k: "<html>Access Denied</html>")
        assert probe("RELIANCE.NS")["documents"][0]["unmapped_lines"]

    def test_reports_no_filings_honestly(self, monkeypatch):
        monkeypatch.setattr("lib.nse._get", lambda *a, **k: None)
        assert probe("RELIANCE.NS")["ok"] is False

    def test_refuses_a_ticker_it_cannot_clean(self):
        assert probe("^NSEI")["ok"] is False

    def test_flags_which_document_is_primary(self, both_bases):
        r = probe("RELIANCE.NS")
        assert r["preferred_basis"] == "consolidated"
        assert r["selected_index"] == 0
        assert [d["primary"] for d in r["documents"]] == [True, False]
        assert [d["basis"] for d in r["documents"]] == ["consolidated", "standalone"]
        assert "consolidated" in r["documents"][0]["primary_reason"]
        assert "same period" in r["documents"][1]["primary_reason"]

    def test_the_override_moves_the_primary_flag(self, both_bases):
        r = probe("RELIANCE.NS", prefer="standalone")
        assert [d["primary"] for d in r["documents"]] == [False, True]
        assert r["selected_index"] == 1

    def test_both_bases_reconcile_on_their_own_terms(self, both_bases):
        r = probe("RELIANCE.NS")
        for d in r["documents"]:
            assert [c for c in d["consistency"] if c["status"] == "MISMATCH"] == [], \
                d["basis"]
