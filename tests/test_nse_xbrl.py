"""XBRL instance parsing.

The first version of the NSE statements code read the announcement index and
looked for line items in it. There were none — that endpoint carries filing
metadata and a link, nothing else. The numbers are in the linked XBRL, and
these pin the three things about reading it that are correctness hazards
rather than conveniences: which context a fact belongs to, what `decimals`
means, and what a nil fact means.
"""
from pathlib import Path

import pytest

from lib.nse_xbrl import (
    choose_context, facts_by_context, local_name, parse_document, period_shape,
)

FIXTURE = Path(__file__).parent / "fixtures" / "nse_results_q3.xml"


@pytest.fixture(scope="module")
def doc():
    return parse_document(FIXTURE.read_text())


class TestPeriodShape:
    def test_names_an_indian_quarter(self):
        from datetime import date
        assert period_shape(date(2024, 10, 1), date(2024, 12, 31)) == "quarter"

    def test_tells_a_quarter_from_a_nine_month_cumulative(self):
        # Both sit in the same document; only the span separates them, and
        # reading the cumulative as a quarter overstates revenue threefold.
        from datetime import date
        assert period_shape(date(2024, 4, 1), date(2024, 12, 31)) == "nine_month"
        assert period_shape(date(2023, 4, 1), date(2024, 3, 31)) == "year"

    def test_REFUSES_to_name_a_span_that_is_no_reporting_window(self):
        # A 45-day stub is not a quarter, and calling it the nearest thing
        # would put half a quarter's revenue in a quarterly column.
        from datetime import date
        assert period_shape(date(2024, 10, 1), date(2024, 11, 14)) is None
        assert period_shape(None, date(2024, 12, 31)) is None


class TestParsing:
    def test_strips_the_namespace_from_a_tag(self):
        assert local_name("{http://www.nseindia.com/xbrl}RevenueFromOperations") \
            == "RevenueFromOperations"
        assert local_name("Revenue") == "Revenue"

    def test_reads_the_contexts_and_classifies_each_one(self, doc):
        shapes = {c["id"]: c["shape"] for c in doc["contexts"].values()}
        assert shapes["Q3FY25"] == "quarter"
        assert shapes["Q3FY24"] == "quarter"
        assert shapes["NineMFY25"] == "nine_month"
        assert shapes["FY24"] == "year"
        # An instant is a balance-sheet date, not a window.
        assert shapes["AsAt31Dec2024"] is None

    def test_records_a_segment_dimension(self, doc):
        assert doc["contexts"]["Q3FY25Retail"]["dims"] == [
            ("BusinessSegmentAxis", "RetailSegmentMember")]
        assert doc["contexts"]["Q3FY25"]["dims"] == []

    def test_reads_the_unit_a_number_is_denominated_in(self, doc):
        assert "INR" in doc["units"]["INR"]
        # EPS is a ratio of two measures, not a plain currency amount.
        assert "shares" in doc["units"]["INRPerShare"]

    def test_takes_the_value_as_stated_and_does_NOT_apply_decimals(self, doc):
        # decimals="-7" says "accurate to the nearest crore". Treating it as a
        # multiplier would be a 10-million-fold error.
        facts = facts_by_context(doc["facts"])["Q3FY25"]
        assert facts["RevenueFromOperations"]["value"] == 2432730000000
        assert facts["RevenueFromOperations"]["decimals"] == "-7"

    def test_SKIPS_a_nil_fact_rather_than_reading_it_as_zero(self, doc):
        # "not reported" and "zero" are different claims, and every margin
        # computed from the line inherits the difference.
        assert "ExceptionalItems" not in facts_by_context(doc["facts"])["Q3FY25"]

    def test_keeps_facts_of_different_contexts_apart(self, doc):
        by_ctx = facts_by_context(doc["facts"])
        assert by_ctx["Q3FY25"]["RevenueFromOperations"]["value"] == 2432730000000
        assert by_ctx["Q3FY24"]["RevenueFromOperations"]["value"] == 2255350000000
        assert by_ctx["NineMFY25"]["RevenueFromOperations"]["value"] == 7050000000000

    def test_survives_a_document_that_is_not_xml(self):
        # NSE serves an HTML error page under a 200 often enough that this
        # has to degrade to "no data" rather than a 500.
        bad = parse_document("<html><body>Access Denied</body></html>")
        assert bad["facts"] == []
        assert parse_document("")["error"]


class TestContextChoice:
    def test_picks_the_quarter_whose_end_date_was_asked_for(self, doc):
        assert choose_context(doc["contexts"], "quarter", "2024-12-31") == "Q3FY25"
        assert choose_context(doc["contexts"], "quarter", "2023-12-31") == "Q3FY24"

    def test_NEVER_substitutes_a_different_period(self, doc):
        # Returning the nearest quarter instead would file Q2's numbers under
        # Q3's heading, which no reader could detect.
        assert choose_context(doc["contexts"], "quarter", "2024-09-30") is None

    def test_prefers_the_group_figure_over_a_segment(self, doc):
        # Both contexts cover the same quarter; the dimensioned one is one
        # division's revenue, an eighth of the group's.
        assert choose_context(doc["contexts"], "quarter", "2024-12-31") == "Q3FY25"

    def test_falls_back_to_the_latest_period_of_that_shape(self, doc):
        assert choose_context(doc["contexts"], "quarter") == "Q3FY25"
        assert choose_context(doc["contexts"], "year") == "FY24"

    def test_has_nothing_to_pick_when_no_context_has_that_shape(self, doc):
        assert choose_context(doc["contexts"], "half") is None
