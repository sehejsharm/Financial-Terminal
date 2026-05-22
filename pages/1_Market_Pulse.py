"""Market Pulse - indices, sectors, movers, and headlines (India + global)."""
from datetime import datetime, timedelta, timezone

import plotly.graph_objects as go
import streamlit as st

from lib.charts import GREEN, RED, render_price_chart, render_sparkline
from lib.market_data import (
    INDEX_TICKERS,
    PERIOD_LABELS,
    PRIMARY_INDEX,
    SECTORS,
    get_history,
    get_history_bulk,
    get_movers,
    get_quotes_bulk,
)
from lib.news import market_news, time_ago
from lib.logos import logo_img_html
from lib.ui import color_pct_html, cur_symbol, disclosure, fmt_num, setup_page

setup_page("Market Pulse")
st.title("Market Pulse")

# ---- Controls -----------------------------------------------------------
period = st.segmented_control("Period", PERIOD_LABELS, default="1D", key="mp_period")
period = period or "1D"
is_1d = period == "1D"

if "watchlist" not in st.session_state:
    st.session_state.watchlist = []

with st.expander("Add any security to the grid", expanded=False):
    cadd1, cadd2 = st.columns([3, 1])
    with cadd1:
        new_sym = st.text_input(
            "Ticker (Yahoo format)",
            placeholder="e.g. AAPL, TSLA, ^FTSE, ^N225, EURUSD=X, RELIANCE.NS",
            label_visibility="collapsed",
        ).strip().upper()
    with cadd2:
        if st.button("Add", use_container_width=True) and new_sym:
            if new_sym not in INDEX_TICKERS and new_sym not in st.session_state.watchlist:
                st.session_state.watchlist.append(new_sym)
    if st.session_state.watchlist:
        keep = st.multiselect(
            "Your added tickers (deselect to remove)",
            options=st.session_state.watchlist,
            default=st.session_state.watchlist,
        )
        st.session_state.watchlist = keep

# ---- Index / asset grid -------------------------------------------------
grid_tickers = list(INDEX_TICKERS.keys()) + list(st.session_state.watchlist)
quotes = get_quotes_bulk(tuple(grid_tickers))
hist_map = get_history_bulk(tuple(grid_tickers), period)

st.subheader("Indices, commodities & watchlist")
for start in range(0, len(grid_tickers), 4):
    row = grid_tickers[start:start + 4]
    cols = st.columns(4)
    for col, tk in zip(cols, row):
        q = quotes.get(tk, {})
        with col:
            name = INDEX_TICKERS.get(tk, tk)
            price = q.get("price")
            pct = q.get("change_pct")
            sym = "" if tk in INDEX_TICKERS else cur_symbol(q.get("currency"))
            st.markdown(
                f'<div class="sma-card"><div class="nm">{name}</div>'
                f'<div class="px">{sym}{fmt_num(price, 2)}</div>'
                f'{color_pct_html(pct)}</div>',
                unsafe_allow_html=True,
            )
            df = hist_map.get(tk)
            baseline = q.get("prev_close") if is_1d else None
            st.plotly_chart(
                render_sparkline(df, baseline_price=baseline, height=54),
                use_container_width=True,
                key=f"spark_{tk}",
            )

# ---- Big primary index chart -------------------------------------------
st.subheader("NIFTY 50")
bcv1, bcv2, bcv3 = st.columns([3, 3, 1])
with bcv1:
    view = st.segmented_control(
        "View", ["Performance", "Price", "Candlestick", "Area"],
        default="Area", key="mp_view")
with bcv2:
    mp_mas = st.multiselect("Moving averages", [20, 50, 100, 200],
                            default=[], key="mp_mas",
                            format_func=lambda w: f"SMA {w}")
with bcv3:
    mp_bb = st.toggle("Bollinger", value=False, key="mp_bb")
idx_hist = get_history(PRIMARY_INDEX, period)
idx_baseline = quotes.get(PRIMARY_INDEX, {}).get("prev_close") if is_1d else None
st.plotly_chart(
    render_price_chart(idx_hist, view=view or "Area", baseline_price=idx_baseline,
                       height=440, mas=mp_mas, bollinger=mp_bb),
    use_container_width=True,
)

# ---- Sector heatmap -----------------------------------------------------
st.subheader("Sectors today")
sector_q = get_quotes_bulk(tuple(SECTORS.keys()))
sector_rows = sorted(
    [{"name": SECTORS[t], "pct": sector_q.get(t, {}).get("change_pct")}
     for t in SECTORS],
    key=lambda r: (r["pct"] is None, r["pct"] or 0),
)
labels = [r["name"] for r in sector_rows]
vals = [r["pct"] if r["pct"] is not None else 0 for r in sector_rows]
colors = [GREEN if v >= 0 else RED for v in vals]
fig = go.Figure(go.Bar(
    x=vals, y=labels, orientation="h", marker_color=colors,
    text=[f"{v:+.2f}%" for v in vals], textposition="outside",
))
fig.update_layout(template="plotly_dark", height=420,
                  paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                  font=dict(family="JetBrains Mono, monospace", color="#cdd1d8"),
                  margin=dict(l=10, r=40, t=10, b=10), xaxis_title="Daily % change")
st.plotly_chart(fig, use_container_width=True)

# ---- Movers (NIFTY 50 universe) ----------------------------------------
st.subheader("Movers (NIFTY 50)")
rupee = cur_symbol("INR")


def render_movers(title: str, kind: str):
    st.markdown(f"**{title}**")
    movers = get_movers(kind, count=8)
    if not movers:
        st.caption("Data unavailable right now.")
        return
    for m in movers:
        tk = (m.get("symbol") or "").replace(".NS", "")
        pct = m.get("change_pct")
        price = m.get("price")
        st.markdown(
            f'<div class="sma-row">{logo_img_html(tk, 24)}'
            f'<span class="tk">{tk}</span>'
            f'<span class="nm" style="flex:1;overflow:hidden;text-overflow:ellipsis;'
            f'white-space:nowrap;">{m.get("name","")}</span>'
            f'<span>{rupee}{fmt_num(price, 2)}</span>'
            f'<span>{color_pct_html(pct)}</span></div>',
            unsafe_allow_html=True,
        )


mc1, mc2, mc3 = st.columns(3)
with mc1:
    render_movers("Top gainers", "gainers")
with mc2:
    render_movers("Top losers", "losers")
with mc3:
    render_movers("Most active", "actives")

# ---- Headlines ----------------------------------------------------------
st.subheader("Top headlines (last 24h)")
cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
news = market_news(limit=20)
recent = [n for n in news if n.get("published") and n["published"] >= cutoff]
shown = (recent or news)[:3]
if not shown:
    st.caption("No recent headlines available.")
for n in shown:
    summ = (n.get("summary") or "")[:220]
    st.markdown(
        f'<div class="sma-news">'
        f'<a href="{n.get("link","#")}" target="_blank">{n["title"]}</a>'
        f'<div class="meta">{n.get("publisher","")} · {time_ago(n.get("published"))}</div>'
        f'<div class="sum">{summ}</div></div>',
        unsafe_allow_html=True,
    )

disclosure()
