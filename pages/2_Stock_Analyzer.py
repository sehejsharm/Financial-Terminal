"""Stock Analyzer - snapshot gauges, key stats, and AI analysis."""
import streamlit as st

from lib import claude_analyst
from lib.charts import render_price_chart
from lib.logos import logo_img_html
from lib.market_data import (
    PERIOD_LABELS,
    get_history,
    get_quote,
    get_stock_fundamentals,
)
from lib.news import ticker_news, time_ago
from lib.signals import (
    at_a_glance,
    compute_fundamental_score,
    compute_technical_score,
)
from lib.ui import (
    cur_symbol,
    disclosure,
    fmt_num,
    fmt_pct,
    human_number,
    quality_gauge,
    render_chips,
    setup_page,
)

setup_page("Stock Analyzer")
st.title("Stock Analyzer")

c1, c2 = st.columns([2, 3])
with c1:
    ticker = st.text_input("Ticker", value="RELIANCE.NS").strip().upper()
with c2:
    period = st.segmented_control("Period", PERIOD_LABELS, default="1Y",
                                  key="sa_period") or "1Y"

if not ticker:
    st.info("Enter a ticker symbol to begin.")
    st.stop()

f = get_stock_fundamentals(ticker)
quote = get_quote(ticker)
hist = get_history(ticker, period)
hist_1y = get_history(ticker, "1Y")  # used for scoring regardless of view period

if (f.get("price") is None and quote.get("price") is None and hist.empty):
    st.error(f"Could not load data for '{ticker}'. Check the symbol and try again.")
    st.stop()

price = f.get("price") or quote.get("price")
cur = cur_symbol(f.get("currency") or quote.get("currency"))

# ---- Header -------------------------------------------------------------
h1, h2 = st.columns([1, 6])
with h1:
    st.markdown(logo_img_html(ticker, 64), unsafe_allow_html=True)
with h2:
    st.markdown(f"### {f.get('name', ticker)}  \n"
                f"**{ticker}** · {f.get('sector') or '—'} / {f.get('industry') or '—'}")

m1, m2, m3, m4 = st.columns(4)
m1.metric("Price", f"{cur}{fmt_num(price, 2)}",
          delta=fmt_pct(quote.get("change_pct")) if quote.get("change_pct") else None)
m2.metric("Market cap", human_number(f.get("market_cap"), cur))
m3.metric("Trailing P/E", fmt_num(f.get("trailing_pe"), 1))
m4.metric("Beta", fmt_num(f.get("beta"), 2))

# ---- Big chart ----------------------------------------------------------
cv1, cv2, cv3 = st.columns([3, 3, 1])
with cv1:
    view = st.segmented_control(
        "View", ["Performance", "Price", "Candlestick", "Area"],
        default="Price", key="sa_view") or "Price"
with cv2:
    mas = st.multiselect("Moving averages", [20, 50, 100, 200],
                         default=[50, 200], key="sa_mas",
                         format_func=lambda w: f"SMA {w}")
with cv3:
    bb = st.toggle("Bollinger", value=False, key="sa_bb")
baseline = quote.get("prev_close") if period == "1D" else None
st.plotly_chart(
    render_price_chart(hist, view=view, baseline_price=baseline,
                       show_volume=True, height=480, mas=mas, bollinger=bb),
    use_container_width=True,
)

# ---- Snapshot -----------------------------------------------------------
st.subheader("Snapshot")
st.caption(
    "Descriptive measures of price action and fundamentals. These are not "
    "buy/sell signals or recommendations — they summarize the data factually."
)

tech_score, tech_drivers, _ = compute_technical_score(hist_1y, f)
fund_score, fund_drivers, _ = compute_fundamental_score(f)
chips = at_a_glance(hist_1y, f)

s1, s2, s3 = st.columns(3)
with s1:
    st.markdown("**At a glance**")
    render_chips(chips)
with s2:
    st.plotly_chart(
        quality_gauge(tech_score, "Technical strength",
                      "Trend, momentum, position vs averages"),
        use_container_width=True,
    )
    for d in tech_drivers[:5]:
        st.markdown(f"- {d}")
with s3:
    st.plotly_chart(
        quality_gauge(fund_score, "Fundamental quality",
                      "Margins, returns, leverage, growth"),
        use_container_width=True,
    )
    for d in fund_drivers[:5]:
        st.markdown(f"- {d}")

# ---- Key statistics -----------------------------------------------------
st.subheader("Key statistics")


def stat_block(title: str, items: list[tuple]):
    st.markdown(f"**{title}**")
    for label, val in items:
        st.markdown(
            f'<div class="sma-chip"><span class="lab">{label}</span>'
            f'<span class="val">{val}</span></div>',
            unsafe_allow_html=True,
        )


k1, k2, k3 = st.columns(3)
with k1:
    stat_block("Valuation", [
        ("Trailing P/E", fmt_num(f.get("trailing_pe"), 1)),
        ("Forward P/E", fmt_num(f.get("forward_pe"), 1)),
        ("PEG", fmt_num(f.get("peg"), 2)),
        ("Price/Book", fmt_num(f.get("price_to_book"), 2)),
        ("Price/Sales", fmt_num(f.get("price_to_sales"), 2)),
    ])
    stat_block("Income", [
        ("Revenue", human_number(f.get("revenue"), cur)),
        ("EBITDA", human_number(f.get("ebitda"), cur)),
        ("Free cash flow", human_number(f.get("free_cashflow"), cur)),
        ("EPS (TTM)", fmt_num(f.get("eps_trailing"), 2)),
    ])
with k2:
    stat_block("Profitability", [
        ("ROE", fmt_pct((f.get("roe") or 0) * 100) if f.get("roe") is not None else "—"),
        ("ROA", fmt_pct((f.get("roa") or 0) * 100) if f.get("roa") is not None else "—"),
        ("Gross margin", fmt_pct((f.get("gross_margin") or 0) * 100) if f.get("gross_margin") is not None else "—"),
        ("Operating margin", fmt_pct((f.get("operating_margin") or 0) * 100) if f.get("operating_margin") is not None else "—"),
        ("Net margin", fmt_pct((f.get("profit_margin") or 0) * 100) if f.get("profit_margin") is not None else "—"),
    ])
    stat_block("Balance sheet", [
        ("Debt/Equity", fmt_num(f.get("debt_to_equity"), 0)),
        ("Current ratio", fmt_num(f.get("current_ratio"), 2)),
        ("Quick ratio", fmt_num(f.get("quick_ratio"), 2)),
    ])
with k3:
    stat_block("Trading", [
        ("52-week high", fmt_num(f.get("fifty_two_high"), 2)),
        ("52-week low", fmt_num(f.get("fifty_two_low"), 2)),
        ("50-day avg", fmt_num(f.get("fifty_day_avg"), 2)),
        ("200-day avg", fmt_num(f.get("two_hundred_day_avg"), 2)),
        ("Avg volume", human_number(f.get("avg_volume"))),
    ])
    stat_block("Analyst", [
        ("Target (mean)", fmt_num(f.get("target_mean"), 2)),
        ("Target (high)", fmt_num(f.get("target_high"), 2)),
        ("Target (low)", fmt_num(f.get("target_low"), 2)),
        ("# Analysts", fmt_num(f.get("num_analysts"), 0)),
    ])

# ---- Business summary ---------------------------------------------------
if f.get("summary"):
    with st.expander("Business summary"):
        st.write(f["summary"])

# ---- AI analysis --------------------------------------------------------
st.subheader("AI analysis")
tab_bb, tab_deep, tab_news = st.tabs(["Bull / Bear case", "Deep analysis",
                                      "Recent headlines"])

tech_ctx = {"technical_score": tech_score, "fundamental_score": fund_score,
            "drivers": tech_drivers}

with tab_bb:
    if not claude_analyst.is_available():
        st.info("Add your ANTHROPIC_API_KEY to .env to enable AI analysis.")
    elif st.button("Generate bull / bear case", key="bb_btn"):
        with st.spinner("Asking Claude..."):
            try:
                st.markdown(claude_analyst.bull_bear_case(ticker, f, tech_ctx))
            except claude_analyst.AnalystError as e:
                st.error(f"AI analysis failed: {e}")

with tab_deep:
    if not claude_analyst.is_available():
        st.info("Add your ANTHROPIC_API_KEY to .env to enable AI analysis.")
    elif st.button("Generate deep analysis", key="deep_btn"):
        with st.spinner("Asking Claude..."):
            try:
                st.markdown(claude_analyst.deep_analysis(ticker, f, tech_ctx))
            except claude_analyst.AnalystError as e:
                st.error(f"AI analysis failed: {e}")

with tab_news:
    items = ticker_news(ticker, limit=8)
    if not items:
        st.caption("No recent headlines found.")
    for n in items:
        st.markdown(
            f'<div class="sma-news">'
            f'<a href="{n.get("link","#")}" target="_blank">{n["title"]}</a>'
            f'<div class="meta">{n.get("publisher","")} · {time_ago(n.get("published"))}</div>'
            f'<div class="sum">{(n.get("summary") or "")[:200]}</div></div>',
            unsafe_allow_html=True,
        )

disclosure()
