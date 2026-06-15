"""Formatting helpers in lib.ui (pure, no Streamlit runtime needed)."""
from lib.ui import cur_symbol, fmt_num, fmt_pct, human_number


def test_human_number_suffixes():
    assert human_number(1_500) == "1.50K"
    assert human_number(2_000_000) == "2.00M"
    assert human_number(3_000_000_000) == "3.00B"
    assert human_number(4_000_000_000_000) == "4.00T"
    assert human_number(999) == "999.00"


def test_human_number_prefix_and_sign():
    assert human_number(-1500, "$") == "-$1.50K"
    assert human_number(None) == "—"
    assert human_number("not-a-number") == "—"


def test_fmt_pct():
    assert fmt_pct(5) == "+5.00%"
    assert fmt_pct(-3.5) == "-3.50%"
    assert fmt_pct(None) == "—"


def test_fmt_num():
    assert fmt_num(1234.5) == "1,234.50"
    assert fmt_num(None) == "—"
    assert fmt_num("bad") == "—"


def test_cur_symbol():
    assert cur_symbol("USD") == "$"
    assert cur_symbol("INR") == "₹"
    assert cur_symbol("usd") == "$"
    assert cur_symbol(None) == ""
    assert cur_symbol("ZZZ") == ""
