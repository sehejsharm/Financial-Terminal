"""Regression tests for the wrong-company news bug.

Reported symptom: asking for RELIANCE.NS returned stories about Reliance
Steel & Aluminum (NYSE: RS), an American metals distributor with no
relationship to Reliance Industries. The cause was matching news on the bare
symbol text, so any company sharing a first word matched.

The collision pairs below are the ones that actually occur in Indian
markets. Each is asserted in BOTH directions: the wrong company's story must
be dropped, and the right company's story must survive. A filter that fixes
the false positive by dropping everything is not a fix.
"""
from __future__ import annotations

import pytest

from lib import news_relevance as nr

RELIANCE = nr.entity("RELIANCE.NS", "Reliance Industries Limited", "INE002A01018")
TITAN = nr.entity("TITAN.NS", "Titan Company Limited", "INE280A01028")
INFY = nr.entity("INFY.NS", "Infosys Limited", "INE009A01021")
TATASTEEL = nr.entity("TATASTEEL.NS", "Tata Steel Limited", "INE081A01020")
TATAMOTORS = nr.entity("TATAMOTORS.NS", "Tata Motors Limited", "INE155A01022")
BAJFINANCE = nr.entity("BAJFINANCE.NS", "Bajaj Finance Limited", "INE296A01024")
MM = nr.entity("M&M.NS", "Mahindra and Mahindra Limited", "INE101A01026")
TECHM = nr.entity("TECHM.NS", "Tech Mahindra Limited", "INE669C01036")
HDFCBANK = nr.entity("HDFCBANK.NS", "HDFC Bank Limited", "INE040A01034")
SBIN = nr.entity("SBIN.NS", "State Bank of India", "INE062A01020")


def head(title, summary=""):
    return {"title": title, "summary": summary}


class TestDistinctiveTokens:
    def test_strips_legal_suffixes(self):
        assert nr.distinctive_tokens("Reliance Industries Limited") == \
            ["reliance", "industries"]
        assert nr.distinctive_tokens("Infosys Ltd.") == ["infosys"]

    def test_keeps_the_identifying_words_of_a_long_name(self):
        assert nr.distinctive_tokens("State Bank of India") == \
            ["state", "bank", "india"]

    def test_drops_single_characters(self):
        # "M&M" normalises to "m m"; matching a story on the letter m would
        # match every story ever written.
        assert nr.distinctive_tokens("Mahindra and Mahindra Limited") == \
            ["mahindra", "mahindra"]

    def test_a_name_of_nothing_but_suffixes_still_yields_tokens(self):
        assert nr.distinctive_tokens("The Company Limited") != []


class TestMatchStrength:
    def test_an_exchange_qualified_symbol_is_exact(self):
        for text in ["RELIANCE.NS jumps 3%", "NSE: RELIANCE hits a high",
                     "Shares of NSE:RELIANCE rose", "BSE: RELIANCE"]:
            assert nr.match_strength(text, RELIANCE) == "exact", text

    def test_the_isin_is_exact(self):
        assert nr.match_strength("ISIN INE002A01018 corporate action",
                                 RELIANCE) == "exact"

    def test_the_full_name_is_a_name_match(self):
        assert nr.match_strength("Reliance Industries posts record profit",
                                 RELIANCE) == "name"

    def test_a_BARE_symbol_is_NOT_exact(self):
        # This is the entire bug. "RELIANCE" on its own identifies nothing.
        assert nr.match_strength("RELIANCE surges", RELIANCE) == "weak"

    def test_a_partial_name_is_weak(self):
        assert nr.match_strength("Reliance Steel beats estimates",
                                 RELIANCE) == "weak"

    def test_an_unrelated_story_is_none(self):
        assert nr.match_strength("Gold hits a record high", RELIANCE) == "none"

    def test_token_matching_is_word_bounded(self):
        # "Infosystems" is not Infosys.
        assert nr.match_strength("Acme Infosystems wins a contract", INFY) == "none"


class TestRelianceCollision:
    """The reported bug, both directions."""

    WRONG = [
        head("Reliance Steel & Aluminum Co. reports Q2 earnings beat"),
        head("Reliance Steel raises dividend",
             "The Los Angeles-based metals distributor said..."),
        head("NYSE: RS climbs after guidance raise"),
        head("Reliance Global Group announces offering"),
        head("Reliance Worldwide Corporation trading update"),
    ]
    RIGHT = [
        head("Reliance Industries Q1 profit rises 12%"),
        head("RIL bets big on retail",
             "Reliance Industries Limited said its retail arm..."),
        head("NSE: RELIANCE hits a 52-week high"),
        head("Jio parent gains", "ISIN INE002A01018 saw heavy volume"),
    ]

    @pytest.mark.parametrize("item", WRONG)
    def test_the_american_metals_distributor_is_dropped(self, item):
        assert nr.is_relevant(item, RELIANCE) is False

    @pytest.mark.parametrize("item", RIGHT)
    def test_the_actual_company_survives(self, item):
        assert nr.is_relevant(item, RELIANCE) is True

    def test_partition_reports_both_sides(self):
        kept, dropped = nr.partition(self.WRONG + self.RIGHT, RELIANCE)
        assert len(kept) == len(self.RIGHT)
        assert len(dropped) == len(self.WRONG)


class TestSingleWordNamesNeedIndianContext:
    def test_titan_pharmaceuticals_does_not_pass_as_titan_company(self):
        assert nr.is_relevant(
            head("Titan Pharmaceuticals announces trial results"), TITAN) is False

    def test_a_bare_titan_story_with_no_india_marker_is_dropped(self):
        assert nr.is_relevant(head("Titan launches a new watch line"), TITAN) is False

    def test_titan_with_an_india_marker_passes(self):
        assert nr.is_relevant(
            head("Titan shares gain 3% on NSE after strong jewellery sales"),
            TITAN) is True
        assert nr.is_relevant(
            head("Titan posts ₹1,200 crore quarterly profit"), TITAN) is True

    def test_an_unambiguous_single_word_name_needs_no_marker(self):
        # Nothing else is called Infosys.
        assert INFY["needs_india_context"] is False
        assert nr.is_relevant(head("Infosys wins a $200m deal"), INFY) is True


class TestIntraGroupCollisions:
    """Indian conglomerates share a first word across unrelated listings."""

    def test_tata_motors_news_is_not_tata_steel_news(self):
        item = head("Tata Motors reports record JLR sales")
        assert nr.is_relevant(item, TATAMOTORS) is True
        assert nr.is_relevant(item, TATASTEEL) is False

    def test_tata_steel_news_is_not_tata_motors_news(self):
        item = head("Tata Steel commissions a new blast furnace")
        assert nr.is_relevant(item, TATASTEEL) is True
        assert nr.is_relevant(item, TATAMOTORS) is False

    def test_bajaj_auto_news_is_not_bajaj_finance_news(self):
        item = head("Bajaj Auto exports climb 18% in June")
        assert nr.is_relevant(item, BAJFINANCE) is False

    def test_tech_mahindra_is_not_mahindra_and_mahindra(self):
        item = head("Tech Mahindra wins a large telecom deal")
        assert nr.is_relevant(item, TECHM) is True
        assert nr.is_relevant(item, MM) is False

    def test_hdfc_life_is_not_hdfc_bank(self):
        assert nr.is_relevant(head("HDFC Life reports premium growth"),
                              HDFCBANK) is False
        assert nr.is_relevant(head("HDFC Bank raises deposit rates"),
                              HDFCBANK) is True


class TestRobustness:
    def test_the_summary_is_searched_as_well_as_the_title(self):
        # Outlets shorten the name in the headline and spell it out below.
        assert nr.is_relevant(
            head("RIL Q1 beats", "Reliance Industries said profit rose"),
            RELIANCE) is True

    def test_an_entity_with_no_resolved_name_falls_back_to_exact_only(self):
        unknown = nr.entity("XYZ.NS")
        assert unknown["tokens"] == []
        assert nr.is_relevant(head("XYZ soars"), unknown) is False
        assert nr.is_relevant(head("NSE: XYZ soars"), unknown) is True

    def test_empty_and_missing_fields_do_not_raise(self):
        assert nr.is_relevant({}, RELIANCE) is False
        assert nr.is_relevant(head(""), RELIANCE) is False
        assert nr.match_strength("", RELIANCE) == "none"

    def test_case_and_punctuation_are_ignored(self):
        assert nr.is_relevant(head("RELIANCE INDUSTRIES' Q1 PROFIT UP"),
                              RELIANCE) is True

    def test_a_multiword_name_matches_out_of_order(self):
        # "State Bank of India" vs "India's State Bank".
        assert nr.is_relevant(head("India's State Bank cuts lending rates"),
                              SBIN) is True


class TestSearchQuery:
    def test_an_nse_ticker_searches_the_quoted_name_with_an_exchange_hint(self):
        q = nr.search_query(RELIANCE)
        assert '"reliance industries"' in q.lower()
        assert "NSE" in q
        # The old query — the bare symbol plus "stock" — is what caused this.
        assert q.strip() != "RELIANCE stock"

    def test_a_symbol_with_no_resolved_name_still_produces_a_query(self):
        assert "XYZ" in nr.search_query(nr.entity("XYZ.NS"))
