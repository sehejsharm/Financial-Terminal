"""Workspace - multi-chart grid (up to 8 customizable panels)."""
import streamlit as st

from lib.charts import render_price_chart
from lib.market_data import PERIOD_LABELS, get_history, get_quote
from lib.ui import disclosure, setup_page

setup_page("Workspace")
st.title("Multi-Chart Workspace")
st.caption("Up to 8 panels. Each panel is independently configurable. "
           "'Industrial Volume' overlays traded volume for the security.")

DEFAULT_TICKERS = ["^NSEI", "^BSESN", "RELIANCE.NS", "TCS.NS",
                   "HDFCBANK.NS", "INFY.NS", "AAPL", "GC=F"]
VIEWS = ["Area", "Price", "Candlestick", "Performance"]

top1, top2 = st.columns(2)
n_charts = top1.slider("Number of charts", 1, 8, 2, key="ws_n")
ncols = top2.select_slider("Columns", options=[1, 2, 3], value=2, key="ws_cols")

cols = st.columns(ncols)
for i in range(n_charts):
    with cols[i % ncols]:
        with st.container(border=True):
            cc1, cc2 = st.columns([3, 2])
            ticker = cc1.text_input(
                "Ticker", value=DEFAULT_TICKERS[i % len(DEFAULT_TICKERS)],
                key=f"ws_tk_{i}").strip().upper()
            period = cc2.selectbox("Period", PERIOD_LABELS,
                                   index=PERIOD_LABELS.index("6M"),
                                   key=f"ws_pd_{i}")
            cc3, cc4, cc5 = st.columns([2, 2, 2])
            view = cc3.selectbox("View", VIEWS, key=f"ws_vw_{i}")
            ind_vol = cc4.toggle("Ind. Volume", value=False, key=f"ws_iv_{i}")
            mas_on = cc5.toggle("SMA 50/200", value=False, key=f"ws_ma_{i}")

            if not ticker:
                st.caption("Enter a ticker.")
                continue
            hist = get_history(ticker, period)
            baseline = (get_quote(ticker).get("prev_close")
                        if period == "1D" else None)
            fig = render_price_chart(
                hist, view=view, baseline_price=baseline, height=320,
                show_volume=ind_vol, mas=[50, 200] if mas_on else None,
                title=ticker,
            )
            st.plotly_chart(fig, use_container_width=True, key=f"ws_ch_{i}")

disclosure()
