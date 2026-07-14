"""News feed must never render raw HTML from upstream feeds."""
from datetime import datetime, timezone

from backend.routes.market import _news_payload, _strip_html


def test_strip_html_wrapped_body():
    raw = "<body><p>STORY: U.S. stocks ended lower...</p></body>"
    assert _strip_html(raw) == "STORY: U.S. stocks ended lower..."


def test_strip_html_entities_and_whitespace():
    assert _strip_html("A &amp; B\n\n  <br/>  C") == "A & B C"


def test_strip_html_passthrough():
    assert _strip_html(None) is None
    assert _strip_html("plain text") == "plain text"


def test_news_payload_sanitizes_all_text_fields():
    items = [{
        "title": "<b>Big news</b>",
        "publisher": "Reuters",
        "link": "https://example.com/x",
        "summary": "<body><p>STORY: markets fell.</p></body>",
        "published": datetime(2026, 7, 14, tzinfo=timezone.utc),
    }]
    out = _news_payload(items)
    assert out[0]["title"] == "Big news"
    assert out[0]["summary"] == "STORY: markets fell."
    assert "<" not in out[0]["summary"]
    assert out[0]["link"] == "https://example.com/x"  # links untouched
