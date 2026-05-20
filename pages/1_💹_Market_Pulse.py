"""Market Pulse - indices, sectors, movers, and headlines."""
from datetime import datetime, timedelta, timezone

import plotly.graph_objects as go
import streamlit as st

from lib.charts import GREEN, RED, render_price_chart, render_sparkline
from lib.market_data import (
    INDEX_TICKERS,
    PERIOD_LABELS,
    SECTOR_ETFS,
    get_history,
    get_history_bulk,
    get_movers,
    get_quotes_bulk,
)
from lib.news import market_news, time_ago
from lib.logos import logo_img_html
from lib.ui import color_pct_html, disclosure, fmt_num, setup_page

setup_page("Market Pulse", "💹")
st.title("💹 Market Pulse")

period = st.segmented_control("Period", PERIOD_LABELS, default="1D", key="mp_period")
period = period or "1D"
is_1d = period == "1D"

# ---- Index / asset grid -------------------------------------------------
tickers = tuple(INDEX_TICKERS.keys())
quotes = get_quotes_bulk(tickers)
hist_map = get_history_bulk(tickers, period)

st.subheader("Indices & assets")
rows = [tickers[:5], tickers[5:]]
for row in rows:
    cols = st.columns(5)
    for col, tk in zip(cols, row):
        q = quotes.get(tk, {})
        with col:
            st.markdown(f"**{INDEX_TICKERS[tk]}**")
            price = q.get("price")
            pct = q.get("change_pct")
            st.markdown(
                f"{fmt_num(price, 2)} &nbsp; {color_pct_html(pct)}",
                unsafe_allow_html=True,
            )
            df = hist_map.get(tk)
            baseline = q.get("prev_close") if is_1d else None
            st.plotly_chart(
                render_sparkline(df, baseline_price=baseline, height=56),
                use_container_width=True,
                key=f"spark_{tk}",
            )

# ---- Big S&P 500 chart --------------------------------------------------
st.subheader("S&P 500 (^GSPC)")
view = st.segmented_control(
    "View", ["Performance", "Price", "Candlestick", "Area"],
    default="Area", key="mp_view",
)
sp_hist = get_history("^GSPC", period)
sp_baseline = quotes.get("^GSPC", {}).get("prev_close") if is_1d else None
st.plotly_chart(
    render_price_chart(sp_hist, view=view or "Area", baseline_price=sp_baseline,
                       height=440),
    use_container_width=True,
)

# ---- Sector heatmap -----------------------------------------------------
st.subheader("Sectors today")
sector_q = get_quotes_bulk(tuple(SECTOR_ETFS.keys()))
sector_rows = sorted(
    [
        {"name": SECTOR_ETFS[t], "ticker": t,
         "pct": sector_q.get(t, {}).get("change_pct")}
        for t in SECTOR_ETFS
    ],
    key=lambda r: (r["pct"] is None, r["pct"] or 0),
)
labels = [f"{r['name']}" for r in sector_rows]
vals = [r["pct"] if r["pct"] is not None else 0 for r in sector_rows]
colors = [GREEN if v >= 0 else RED for v in vals]
fig = go.Figure(go.Bar(
    x=vals, y=labels, orientation="h", marker_color=colors,
    text=[f"{v:+.2f}%" for v in vals], textposition="outside",
))
fig.update_layout(template="plotly_dark", height=420,
                  margin=dict(l=10, r=40, t=10, b=10),
                  xaxis_title="Daily % change")
st.plotly_chart(fig, use_container_width=True)

# ---- Movers -------------------------------------------------------------
st.subheader("Movers")


def render_movers(title: str, kind: str):
    st.markdown(f"**{title}**")
    movers = get_movers(kind, count=8)
    if not movers:
        st.caption("Data unavailable right now.")
        return
    for m in movers:
        tk = m.get("symbol") or ""
        pct = m.get("change_pct")
        price = m.get("price")
        st.markdown(
            f'<div class="sma-row">{logo_img_html(tk, 26)}'
            f'<span class="tk">{tk}</span>'
            f'<span class="nm" style="flex:1;overflow:hidden;text-overflow:ellipsis;'
            f'white-space:nowrap;">{m.get("name","")}</span>'
            f'<span>{fmt_num(price, 2)}</span>'
            f'<span>{color_pct_html(pct)}</span></div>',
            unsafe_allow_html=True,
        )


mc1, mc2, mc3 = st.columns(3)
with mc1:
    render_movers("📈 Top gainers", "gainers")
with mc2:
    render_movers("📉 Top losers", "losers")
with mc3:
    render_movers("🔥 Most active", "actives")

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
