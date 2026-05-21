"""News - aggregated market headlines and by-ticker search."""
import streamlit as st

from lib.news import market_news, ticker_news, time_ago
from lib.ui import disclosure, setup_page

setup_page("News")
st.title("News")


def render_news(items: list[dict]):
    if not items:
        st.caption("No headlines available right now.")
        return
    for n in items:
        st.markdown(
            f'<div class="sma-news">'
            f'<a href="{n.get("link","#")}" target="_blank">{n["title"]}</a>'
            f'<div class="meta">{n.get("publisher","")} · {time_ago(n.get("published"))}</div>'
            f'<div class="sum">{(n.get("summary") or "")[:260]}</div></div>',
            unsafe_allow_html=True,
        )


tab_market, tab_ticker = st.tabs(["Market headlines", "By ticker"])

with tab_market:
    render_news(market_news(limit=20))

with tab_ticker:
    tk = st.text_input("Ticker", value="RELIANCE.NS").strip().upper()
    if tk:
        render_news(ticker_news(tk, limit=15))

disclosure()
