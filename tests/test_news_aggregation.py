"""Headline normalisation, deduplication and date parsing.

The market wire pulls nine feeds. Several of them carry the same wire copy
with different decoration, and they disagree about how to write a date. Both
of those have to be handled here or the page is four copies of one story
sorted at random.
"""
from __future__ import annotations

from datetime import datetime, timezone

from lib import news


class TestNormTitle:
    def test_collapses_case_and_punctuation(self):
        assert news.norm_title("Reliance's Q1 PROFIT up 12%!") \
            == news.norm_title("reliance s q1 profit up 12")

    def test_strips_a_trailing_outlet_attribution(self):
        # The same story reaches us as "... - Reuters" and "... | Mint".
        base = news.norm_title("Nifty ends higher on bank buying")
        assert news.norm_title("Nifty ends higher on bank buying - Reuters") == base
        assert news.norm_title("Nifty ends higher on bank buying | Mint") == base

    def test_does_not_eat_a_hyphen_inside_the_headline(self):
        # "Nifty ends higher - here's why" is not an attribution, and the
        # split must not swallow the second half of a real headline.
        out = news.norm_title("Reliance in talks - sources say deal is near for the unit")
        assert "sources say deal is near" in out

    def test_empty_input(self):
        assert news.norm_title("") == ""


class TestDedupe:
    def _it(self, title, link="", published=None):
        return {"title": title, "link": link, "published": published}

    def test_drops_a_repeated_story_and_keeps_the_first(self):
        items = [self._it("Reliance profit up 12%", "https://a/1"),
                 self._it("RELIANCE PROFIT UP 12%", "https://b/2")]
        out = news.dedupe(items)
        assert len(out) == 1
        assert out[0]["link"] == "https://a/1"

    def test_matches_on_the_link_when_the_headline_was_rewritten(self):
        items = [self._it("Original headline", "https://a/1"),
                 self._it("A completely different rewrite", "https://a/1?utm=x")]
        assert len(news.dedupe(items)) == 1

    def test_keeps_genuinely_different_stories(self):
        items = [self._it("Reliance profit up", "https://a/1"),
                 self._it("Nifty ends lower", "https://a/2")]
        assert len(news.dedupe(items)) == 2

    def test_drops_items_with_no_usable_title(self):
        assert news.dedupe([self._it(""), self._it("   ")]) == []

    def test_items_without_links_still_dedupe_by_title(self):
        items = [self._it("Same story"), self._it("same story")]
        assert len(news.dedupe(items)) == 1

    def test_preserves_input_order(self):
        items = [self._it("Third", "https://a/3"), self._it("First", "https://a/1")]
        assert [i["title"] for i in news.dedupe(items)] == ["Third", "First"]


class TestParseRssDate:
    def test_parses_the_common_rfc822_shapes(self):
        assert news.parse_rss_date("Wed, 29 Jul 2026 10:30:00 +0530") is not None
        assert news.parse_rss_date("Wed, 29 Jul 2026 10:30:00 GMT") is not None
        assert news.parse_rss_date("29 Jul 2026 10:30:00 +0000") is not None

    def test_always_returns_an_AWARE_datetime(self):
        # Mixing naive and aware datetimes raises on comparison, which is
        # exactly what the newest-first sort does to every item.
        for raw in ("Wed, 29 Jul 2026 10:30:00 GMT",
                    "Wed, 29 Jul 2026 10:30:00 +0530"):
            assert news.parse_rss_date(raw).tzinfo is not None

    def test_respects_the_offset_rather_than_assuming_utc(self):
        ist = news.parse_rss_date("Wed, 29 Jul 2026 10:30:00 +0530")
        utc = news.parse_rss_date("Wed, 29 Jul 2026 05:00:00 +0000")
        assert ist == utc

    def test_returns_none_for_junk_instead_of_raising(self):
        assert news.parse_rss_date("yesterday") is None
        assert news.parse_rss_date("") is None
        assert news.parse_rss_date(None) is None


class TestNewestFirst:
    def test_sorts_newest_first_and_puts_undated_last(self):
        aware = datetime(2026, 7, 29, tzinfo=timezone.utc)
        older = datetime(2026, 7, 1, tzinfo=timezone.utc)
        items = [{"title": "old", "published": older},
                 {"title": "undated", "published": None},
                 {"title": "new", "published": aware}]
        assert [i["title"] for i in news._newest_first(items)] == ["new", "old", "undated"]

    def test_does_not_explode_on_a_naive_datetime(self):
        # yfinance items have arrived both ways; comparing the two raises.
        items = [{"title": "naive", "published": datetime(2026, 7, 29)},
                 {"title": "aware", "published": datetime(2026, 7, 28, tzinfo=timezone.utc)}]
        assert [i["title"] for i in news._newest_first(items)] == ["naive", "aware"]


class TestFeedConfig:
    def test_the_source_list_is_derived_from_the_feeds(self):
        # A filter that offers a source nobody fetches is a dead control.
        assert news.MARKET_SOURCES == [n for n, _ in news.MARKET_FEEDS]

    def test_indian_outlets_lead_the_list(self):
        assert "Economic Times" == news.MARKET_FEEDS[0][0]

    def test_every_feed_has_a_distinct_name_and_an_https_url(self):
        names = [n for n, _ in news.MARKET_FEEDS]
        assert len(set(names)) == len(names)
        assert all(url.startswith("https://") for _, url in news.MARKET_FEEDS)
