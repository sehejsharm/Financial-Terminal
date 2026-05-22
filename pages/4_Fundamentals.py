"""Fundamentals - financial statements, estimates, and capital structure."""
import plotly.graph_objects as go
import streamlit as st

from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
    capital_structure,
    get_estimates,
    get_statement,
    select_rows,
)
from lib.market_data import get_stock_fundamentals
from lib.ui import (
    cur_symbol,
    disclosure,
    human_number,
    setup_page,
    ticker_picker,
)

setup_page("Fundamentals")
st.title("Fundamentals")

c1, c2 = st.columns([2, 2])
with c1:
    ticker = ticker_picker("Search security", default="RELIANCE.NS", key="fn_pick")
with c2:
    freq = st.segmented_control("Period", ["Annual", "Quarterly"],
                                default="Annual", key="fn_freq") or "Annual"
quarterly = freq == "Quarterly"

if not ticker:
    st.info("Enter a ticker to begin.")
    st.stop()

info = get_stock_fundamentals(ticker)
cur = cur_symbol(info.get("currency"))
st.markdown(f"### {info.get('name', ticker)}  \n**{ticker}** · "
            f"{info.get('sector') or '—'}")

CONFIG = {
    "Income statement": ("income", INCOME_ROWS,
                         ["Total Revenue", "Net Income"]),
    "Balance sheet": ("balance", BALANCE_ROWS,
                      ["Total Assets", "Total Liabilities Net Minority Interest"]),
    "Cash flow": ("cashflow", CASHFLOW_ROWS,
                  ["Operating Cash Flow", "Free Cash Flow"]),
}

tabs = st.tabs(list(CONFIG.keys()))
for tab, (label, (kind, rows, chart_rows)) in zip(tabs, CONFIG.items()):
    with tab:
        df = select_rows(get_statement(ticker, kind, quarterly), rows)
        if df.empty:
            st.caption("Statement data unavailable for this ticker.")
            continue

        # Chart of headline lines over time (chronological).
        cols_chrono = list(df.columns)[::-1]
        fig = go.Figure()
        palette = ["#ffb000", "#22d3ee", "#e879f9"]
        for i, r in enumerate([r for r in chart_rows if r in df.index]):
            fig.add_trace(go.Bar(x=cols_chrono, y=[df.loc[r, c] for c in cols_chrono],
                                 name=r, marker_color=palette[i % len(palette)]))
        fig.update_layout(template="plotly_dark", height=320, barmode="group",
                          paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                          font=dict(family="JetBrains Mono, monospace", color="#cdd1d8"),
                          margin=dict(l=10, r=10, t=10, b=10),
                          legend=dict(orientation="h", y=1.1))
        st.plotly_chart(fig, use_container_width=True)

        # Formatted table.
        disp = df.copy()
        for c in disp.columns:
            disp[c] = disp[c].apply(lambda v: human_number(v, cur)
                                    if v is not None else "—")
        st.dataframe(disp, use_container_width=True)

# ---- Capital structure --------------------------------------------------
st.subheader("Capital structure")
cap = capital_structure(ticker)
ccur = cur_symbol(cap.get("currency"))
cc1, cc2 = st.columns([2, 3])
with cc1:
    st.markdown(
        f'<div class="sma-chip"><span class="lab">Market cap (equity)</span>'
        f'<span class="val">{human_number(cap.get("market_cap"), ccur)}</span></div>'
        f'<div class="sma-chip"><span class="lab">Total debt</span>'
        f'<span class="val">{human_number(cap.get("total_debt"), ccur)}</span></div>'
        f'<div class="sma-chip"><span class="lab">Cash</span>'
        f'<span class="val">{human_number(cap.get("cash"), ccur)}</span></div>',
        unsafe_allow_html=True,
    )
with cc2:
    parts = {"Equity (mkt cap)": cap.get("market_cap"),
             "Total debt": cap.get("total_debt"), "Cash": cap.get("cash")}
    parts = {k: v for k, v in parts.items() if v}
    if parts:
        fig = go.Figure(go.Bar(x=list(parts.keys()), y=list(parts.values()),
                               marker_color=["#22d3ee", "#ff4d4f", "#1fd286"]))
        fig.update_layout(template="plotly_dark", height=300,
                          paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                          font=dict(family="JetBrains Mono, monospace", color="#cdd1d8"),
                          margin=dict(l=10, r=10, t=10, b=10))
        st.plotly_chart(fig, use_container_width=True)

# ---- Analyst estimates --------------------------------------------------
st.subheader("Analyst estimates")
est = get_estimates(ticker)
pt = est.get("price_targets")
if isinstance(pt, dict) and pt:
    pc = st.columns(4)
    pc[0].metric("Target mean", f"{cur}{pt.get('mean', '—')}")
    pc[1].metric("Target high", f"{cur}{pt.get('high', '—')}")
    pc[2].metric("Target low", f"{cur}{pt.get('low', '—')}")
    pc[3].metric("Current", f"{cur}{pt.get('current', '—')}")
for key, title in (("earnings_estimate", "Earnings estimates"),
                   ("revenue_estimate", "Revenue estimates"),
                   ("growth_estimates", "Growth estimates")):
    if key in est:
        st.markdown(f"**{title}**")
        st.dataframe(est[key], use_container_width=True)
if not est:
    st.caption("Analyst estimate data unavailable for this ticker.")

disclosure()
