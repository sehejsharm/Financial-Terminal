"""Market Analyst Terminal - landing page with a quick market snapshot."""
import streamlit as st

from lib.charts import render_price_chart
from lib.config import APP_NAME
from lib.market_data import INDEX_TICKERS, PRIMARY_INDEX, get_history, get_quotes_bulk
from lib.ui import disclosure, fmt_num, setup_page

setup_page("Home")

st.title(APP_NAME)
st.markdown(
    "An **educational** markets terminal centered on Indian markets with global "
    "context. Use the pages in the sidebar to dig in."
)

# Quick snapshot of the headline indices/assets.
SNAPSHOT = ["^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX", "INR=X", "GC=F",
            "SI=F", "CL=F"]
quotes = get_quotes_bulk(tuple(SNAPSHOT))

st.subheader("Market snapshot")
cols = st.columns(4)
for i, tk in enumerate(SNAPSHOT):
    q = quotes.get(tk, {})
    price = q.get("price")
    pct = q.get("change_pct")
    name = INDEX_TICKERS.get(tk, tk)
    with cols[i % 4]:
        st.metric(
            label=name,
            value=fmt_num(price, 2) if price is not None else "—",
            delta=f"{pct:+.2f}%" if pct is not None else None,
        )

st.subheader("NIFTY 50")
hist = get_history(PRIMARY_INDEX, "6M")
st.plotly_chart(
    render_price_chart(hist, view="Area", title="NIFTY 50 - last 6 months",
                       height=380),
    use_container_width=True,
)

st.subheader("Explore")
c1, c2, c3 = st.columns(3)
with c1:
    st.markdown("**Market Pulse**\n\nIndices, sectors, movers, watchlist.")
    st.markdown("**Workspace**\n\nMulti-chart grid, up to 8 panels.")
    st.markdown("**Stock Analyzer**\n\nGauges, indicators, RSI, backtests.")
    st.markdown("**Fundamentals**\n\nStatements, estimates, capital structure.")
with c2:
    st.markdown("**Terminal**\n\nSnapshot, comps, ownership, WACC, ratings.")
    st.markdown("**Value Investing**\n\nGraham value + Buffett checklist.")
    st.markdown("**Screeners**\n\nPEG, Hidden Gems, Growth, custom filters.")
    st.markdown("**ETF Analyzer**\n\nRisk, holdings, cost comparison.")
with c3:
    st.markdown("**Derivatives**\n\nOption chains, Greeks, IV smile, max pain.")
    st.markdown("**Big Shark Updates**\n\nBulk / block deal activity (EOD).")
    st.markdown("**Macro**\n\nMacro indicators and the yield curve.")
    st.markdown("**News**\n\nMarket and by-ticker headlines.")

disclosure()
