"""ETF Analyzer - returns, risk, holdings, and cost comparison."""
import plotly.graph_objects as go
import streamlit as st

from lib.charts import GREEN, RED, render_price_chart
from lib.etf_peers import get_peers
from lib.logos import logo_img_html
from lib.market_data import PERIOD_LABELS, get_etf_details, get_history, get_quote
from lib.risk import etf_risk_score
from lib.ui import (
    color_pct_html,
    disclosure,
    fmt_num,
    fmt_pct,
    human_number,
    risk_gauge,
    setup_page,
)

setup_page("ETF Analyzer", "🧺")
st.title("🧺 ETF Analyzer")


def er_to_pct(er):
    """Normalize a yfinance expense ratio to a percentage number."""
    if er is None:
        return None
    er = float(er)
    # yfinance reports as a fraction (0.000945 == 0.0945%).
    return er * 100 if er < 1 else er


c1, c2 = st.columns([2, 3])
with c1:
    ticker = st.text_input("ETF ticker", value="SPY").strip().upper()
with c2:
    period = st.segmented_control("Period", PERIOD_LABELS, default="1Y",
                                  key="etf_period") or "1Y"

if not ticker:
    st.info("Enter an ETF ticker to begin.")
    st.stop()

details = get_etf_details(ticker)
quote = get_quote(ticker)
hist = get_history(ticker, period)
hist_3y = get_history(ticker, "3Y")

if hist.empty and quote.get("price") is None:
    st.error(f"Could not load data for '{ticker}'. Check the symbol and try again.")
    st.stop()

st.markdown(f"### {details.get('name', ticker)}  \n**{ticker}** · "
            f"{details.get('category') or 'ETF'}")

m1, m2, m3, m4 = st.columns(4)
m1.metric("Price", fmt_num(quote.get("price"), 2),
          delta=fmt_pct(quote.get("change_pct")) if quote.get("change_pct") else None)
m2.metric("Expense ratio", f"{er_to_pct(details.get('expense_ratio')):.2f}%"
          if er_to_pct(details.get("expense_ratio")) is not None else "—")
m3.metric("Total assets", human_number(details.get("total_assets"), "$"))
m4.metric("Yield", fmt_pct((details.get("yield") or 0) * 100)
          if details.get("yield") is not None else "—")

# ---- Chart --------------------------------------------------------------
view = st.segmented_control("View", ["Performance", "Price", "Candlestick", "Area"],
                            default="Area", key="etf_view") or "Area"
baseline = quote.get("prev_close") if period == "1D" else None
st.plotly_chart(
    render_price_chart(hist, view=view, baseline_price=baseline, height=440),
    use_container_width=True,
)

# ---- Returns + Risk -----------------------------------------------------
rc1, rc2 = st.columns([3, 2])
with rc1:
    st.subheader("Returns")

    def pct_or_dash(v):
        return fmt_pct(v * 100) if v is not None else "—"

    st.markdown(
        f'<div class="sma-chip"><span class="lab">YTD return</span>'
        f'<span class="val">{pct_or_dash(details.get("ytd_return"))}</span></div>'
        f'<div class="sma-chip"><span class="lab">3Y avg (annualized)</span>'
        f'<span class="val">{pct_or_dash(details.get("three_year_return"))}</span></div>'
        f'<div class="sma-chip"><span class="lab">5Y avg (annualized)</span>'
        f'<span class="val">{pct_or_dash(details.get("five_year_return"))}</span></div>'
        f'<div class="sma-chip"><span class="lab">3Y beta</span>'
        f'<span class="val">{fmt_num(details.get("beta_3y"), 2)}</span></div>',
        unsafe_allow_html=True,
    )

with rc2:
    st.subheader("Risk")
    score, label, color, comp = etf_risk_score(hist_3y, details.get("holdings"))
    st.plotly_chart(risk_gauge(score, "Risk score", label),
                    use_container_width=True)
    bits = []
    if "volatility_pct" in comp:
        bits.append(f"Volatility {comp['volatility_pct']}%")
    if "max_drawdown_pct" in comp:
        bits.append(f"Max drawdown {comp['max_drawdown_pct']}%")
    if "top10_concentration_pct" in comp:
        bits.append(f"Top-10 concentration {comp['top10_concentration_pct']}%")
    if bits:
        st.caption(" · ".join(bits))

# ---- Sector breakdown ---------------------------------------------------
sectors = details.get("sector_weights") or {}
if sectors:
    st.subheader("Sector breakdown")
    items = sorted(sectors.items(), key=lambda kv: kv[1], reverse=True)
    fig = go.Figure(go.Bar(
        x=[v * 100 for _, v in items], y=[k for k, _ in items],
        orientation="h", marker_color="#60a5fa",
        text=[f"{v * 100:.1f}%" for _, v in items], textposition="outside",
    ))
    fig.update_layout(template="plotly_dark", height=360,
                      margin=dict(l=10, r=40, t=10, b=10),
                      yaxis=dict(autorange="reversed"), xaxis_title="Weight %")
    st.plotly_chart(fig, use_container_width=True)

# ---- Top holdings -------------------------------------------------------
holdings = details.get("holdings") or []
if holdings:
    st.subheader("Top holdings")
    cols = st.columns(2)
    for i, h in enumerate(holdings[:10]):
        sym = h.get("symbol", "")
        w = h.get("weight")
        with cols[i % 2]:
            st.markdown(
                f'<div class="sma-row">{logo_img_html(sym, 26)}'
                f'<span class="tk">{sym}</span>'
                f'<span class="nm" style="flex:1;overflow:hidden;text-overflow:ellipsis;'
                f'white-space:nowrap;">{h.get("name","")}</span>'
                f'<span class="val">{w * 100:.2f}%</span></div>'
                if w is not None else
                f'<div class="sma-row">{logo_img_html(sym, 26)}'
                f'<span class="tk">{sym}</span>'
                f'<span class="nm" style="flex:1;">{h.get("name","")}</span></div>',
                unsafe_allow_html=True,
            )

# ---- Peer cost comparison ----------------------------------------------
peers = get_peers(ticker)
if len(peers) > 1:
    st.subheader("Peer cost comparison")
    peer_rows = []
    for p in peers:
        d = get_etf_details(p)
        peer_rows.append({
            "ticker": p,
            "name": d.get("name", p),
            "er": er_to_pct(d.get("expense_ratio")),
            "assets": d.get("total_assets"),
        })
    peer_rows.sort(key=lambda r: (r["er"] is None, r["er"] or 0))

    header = ('<div class="sma-row" style="font-weight:700;color:#94a3b8;">'
              '<span style="flex:0 0 70px;">Ticker</span>'
              '<span style="flex:1;">Name</span>'
              '<span style="flex:0 0 110px;text-align:right;">Expense ratio</span>'
              '<span style="flex:0 0 110px;text-align:right;">Assets</span></div>')
    body = []
    for r in peer_rows:
        mark = " ◀" if r["ticker"] == ticker else ""
        er_txt = f"{r['er']:.2f}%" if r["er"] is not None else "—"
        body.append(
            f'<div class="sma-row"><span style="flex:0 0 70px;" class="tk">{r["ticker"]}{mark}</span>'
            f'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{r["name"]}</span>'
            f'<span style="flex:0 0 110px;text-align:right;">{er_txt}</span>'
            f'<span style="flex:0 0 110px;text-align:right;">{human_number(r["assets"], "$")}</span></div>'
        )
    st.markdown(header + "".join(body), unsafe_allow_html=True)

    # Cheaper-alternatives callout.
    current_er = er_to_pct(details.get("expense_ratio"))
    cheaper = [r for r in peer_rows
               if r["er"] is not None and current_er is not None
               and r["er"] < current_er]
    if cheaper:
        best = cheaper[0]
        bps = (current_er - best["er"]) * 100  # percentage points -> basis points
        dollars = (current_er - best["er"]) / 100 * 100_000
        st.info(
            f"💡 **{best['ticker']}** has a lower expense ratio than **{ticker}** "
            f"({best['er']:.2f}% vs {current_er:.2f}%) — about **{bps:.0f} bps** "
            f"cheaper, or roughly **${dollars:,.0f}/yr** on a $100K position. "
            "Funds may differ in holdings, tracking, and tax treatment; this is "
            "an educational cost comparison, not a recommendation."
        )

disclosure()
