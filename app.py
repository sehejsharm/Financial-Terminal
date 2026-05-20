"""Stock Market Analyst - landing page with a quick market snapshot."""
import streamlit as st

from lib.charts import render_price_chart
from lib.config import APP_NAME
from lib.market_data import INDEX_TICKERS, get_history, get_quotes_bulk
from lib.ui import disclosure, fmt_num, setup_page

setup_page("Home", "📈")

st.title(f"📈 {APP_NAME}")
st.markdown(
    "A personal, **educational** dashboard for exploring markets, companies, "
    "ETFs, and macro data. Use the pages in the sidebar to dig in."
)

# Quick snapshot of the headline indices/assets.
SNAPSHOT = ["^GSPC", "^NDX", "^DJI", "^RUT", "^VIX", "^TNX", "GC=F", "BTC-USD"]
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

st.subheader("S&P 500")
hist = get_history("^GSPC", "6M")
st.plotly_chart(
    render_price_chart(hist, view="Area", title="S&P 500 - last 6 months", height=380),
    use_container_width=True,
)

st.subheader("Explore")
c1, c2, c3 = st.columns(3)
with c1:
    st.markdown("**💹 Market Pulse**\n\nIndices, sectors, movers, headlines.")
    st.markdown("**🔍 Stock Analyzer**\n\nSnapshot gauges, stats, AI analysis.")
with c2:
    st.markdown("**🧺 ETF Analyzer**\n\nRisk, holdings, cost comparison.")
    st.markdown("**🌍 Macro**\n\nFRED indicators and the yield curve.")
with c3:
    st.markdown("**💼 Portfolio**\n\nTrack holdings, allocation, risk.")
    st.markdown("**📰 News**\n\nMarket and by-ticker headlines.")

disclosure()
