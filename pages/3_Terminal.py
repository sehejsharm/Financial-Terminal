"""Terminal — single-name one-stop analysis (Bloomberg-style).

Pick a ticker once, then run any analysis function on it: snapshot, technicals,
financials, estimates, comparables, ownership, ratings, WACC, value chain,
options, ETF profile, AI deep-dive, news.  Replaces the old Stock Analyzer,
Fundamentals, Derivatives and ETF Analyzer pages.
"""
from __future__ import annotations

import plotly.graph_objects as go
import streamlit as st

from lib import ai_analyst, value_chain as vc
from lib.backtest import run_backtest
from lib.charts import render_backtest_chart, render_price_chart, render_rsi
from lib.etf_peers import get_peers
from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
    capital_structure,
    get_estimates,
    get_statement,
    select_rows,
)
from lib.institutional import (
    capm_cost_of_equity,
    comps_matrix,
    get_earnings_history,
    get_officers,
    get_ownership,
    get_ratings,
    wacc,
)
from lib.logos import logo_img_html
from lib.market_data import (
    PERIOD_LABELS,
    get_etf_details,
    get_history,
    get_quote,
    get_stock_fundamentals,
    is_etf,
)
from lib.news import ticker_news, time_ago
from lib.options import (
    enrich_with_greeks,
    get_expiries,
    get_option_chain,
    max_pain,
    years_to_expiry,
)
from lib.risk import etf_risk_score
from lib.signals import (
    at_a_glance,
    compute_fundamental_score,
    compute_technical_score,
)
from lib.ui import (
    color_pct_html,
    cur_symbol,
    disclosure,
    download_csv_button,
    fmt_num,
    fmt_pct,
    human_number,
    quality_gauge,
    render_chips,
    risk_gauge,
    setup_page,
    ticker_picker,
)
from lib.value_investing import (
    buffett_checklist,
    graham_intrinsic_value,
    margin_of_safety,
)

setup_page("Terminal")

# ── header & ticker selection ────────────────────────────────────────────────
st.title("Terminal")
st.caption("Load any security, then pick a function. Single-name research, "
           "Bloomberg-style.")

# Accept a ticker passed in via session_state (from Workspace / Screeners /
# Market Pulse "Open in Terminal" buttons).
_pending = st.session_state.pop("nav_ticker", None)
_default = _pending or "RELIANCE.NS"

# Helper: function lists tailored by asset type.
STOCK_FUNCTIONS = [
    "Snapshot",
    "Technicals & charts",
    "Financials",
    "Estimates & targets",
    "Capital structure",
    "Comparables",
    "Debt profile",
    "Ownership / insiders",
    "Earnings history",
    "Street ratings",
    "WACC model",
    "Value-chain map",
    "Options & Greeks",
    "AI deep-dive",
    "Recent news",
]
ETF_FUNCTIONS = [
    "Snapshot",
    "Technicals & charts",
    "ETF profile",
    "Peer cost comparison",
    "Options & Greeks",
    "AI deep-dive",
    "Recent news",
]

c1, c2 = st.columns([3, 3])
with c1:
    ticker = ticker_picker("Search security", default=_default, key="tm_pick")
if not ticker:
    st.info("Enter a ticker to begin.")
    st.stop()

# Detect asset class to tailor the function list.
etf = is_etf(ticker)
fn_list = ETF_FUNCTIONS if etf else STOCK_FUNCTIONS
# Preserve function selection across reruns where possible.
prev = st.session_state.get("tm_fn")
default_idx = fn_list.index(prev) if prev in fn_list else 0
with c2:
    fn = st.selectbox("Function", fn_list, index=default_idx, key="tm_fn")

# ── shared data loads ───────────────────────────────────────────────────────
quote = get_quote(ticker)
if etf:
    details = get_etf_details(ticker)
    f = {
        "name": details.get("name", ticker),
        "currency": quote.get("currency"),
        "price": quote.get("price"),
        "market_cap": details.get("total_assets"),
        "sector": details.get("category"),
        "industry": "ETF",
        "summary": details.get("name", ""),
    }
else:
    f = get_stock_fundamentals(ticker)

cur = cur_symbol(f.get("currency") or quote.get("currency"))
price = f.get("price") or quote.get("price")

if price is None and quote.get("price") is None:
    st.error(f"Could not load data for '{ticker}'. Check the symbol.")
    disclosure()
    st.stop()

# ── compact header (always shown) ────────────────────────────────────────────
h1, h2, h3 = st.columns([1, 5, 2])
with h1:
    st.markdown(logo_img_html(ticker, 58), unsafe_allow_html=True)
with h2:
    name = f.get("name", ticker)
    sector = f.get("sector") or "—"
    industry = f.get("industry") or "—"
    asset_tag = "ETF" if etf else "Equity"
    st.markdown(f"### {name}")
    st.markdown(f"**{ticker}** · {asset_tag} · {sector} / {industry}")
with h3:
    cp = quote.get("change_pct")
    st.metric("Price", f"{cur}{fmt_num(price, 2)}",
              delta=f"{cp:+.2f}%" if cp is not None else None)

st.divider()

# ── helper: pretty-print a financial-statement frame ─────────────────────────
def _statement_block(kind, rows, quarterly=False):
    df = select_rows(get_statement(ticker, kind, quarterly), rows)
    if df.empty:
        st.caption("Statement unavailable for this ticker.")
        return
    disp = df.copy()
    for c in disp.columns:
        disp[c] = disp[c].apply(
            lambda v: human_number(v, cur) if v is not None else "—")
    st.dataframe(disp, use_container_width=True)


# ════════════════════════════════════════════════════════════════════════════
# Function rendering
# ════════════════════════════════════════════════════════════════════════════

if fn == "Snapshot":
    m = st.columns(4)
    m[0].metric("Market cap", human_number(f.get("market_cap"), cur))
    m[1].metric("Trailing P/E", fmt_num(f.get("trailing_pe"), 1))
    m[2].metric("Beta", fmt_num(f.get("beta"), 2))
    m[3].metric("52-w range",
                f"{fmt_num(f.get('fifty_two_low'), 2)}–"
                f"{fmt_num(f.get('fifty_two_high'), 2)}")

    if not etf:
        # Quality / technical gauges + at-a-glance chips (from old Stock Analyzer).
        hist_1y = get_history(ticker, "1Y")
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

        # Key statistics blocks
        st.subheader("Key statistics")

        def stat_block(title, items):
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
                ("ROE",  fmt_pct((f.get("roe")  or 0) * 100) if f.get("roe")  is not None else "—"),
                ("ROA",  fmt_pct((f.get("roa")  or 0) * 100) if f.get("roa")  is not None else "—"),
                ("Gross margin",     fmt_pct((f.get("gross_margin")     or 0) * 100) if f.get("gross_margin")     is not None else "—"),
                ("Operating margin", fmt_pct((f.get("operating_margin") or 0) * 100) if f.get("operating_margin") is not None else "—"),
                ("Net margin",       fmt_pct((f.get("profit_margin")    or 0) * 100) if f.get("profit_margin")    is not None else "—"),
            ])
            stat_block("Balance sheet", [
                ("Debt/Equity", fmt_num(f.get("debt_to_equity"), 0)),
                ("Current ratio", fmt_num(f.get("current_ratio"), 2)),
                ("Quick ratio",   fmt_num(f.get("quick_ratio"), 2)),
            ])
        with k3:
            stat_block("Trading", [
                ("52-week high", fmt_num(f.get("fifty_two_high"), 2)),
                ("52-week low",  fmt_num(f.get("fifty_two_low"), 2)),
                ("50-day avg",   fmt_num(f.get("fifty_day_avg"), 2)),
                ("200-day avg",  fmt_num(f.get("two_hundred_day_avg"), 2)),
                ("Avg volume",   human_number(f.get("avg_volume"))),
            ])
            stat_block("Analyst", [
                ("Target (mean)", fmt_num(f.get("target_mean"), 2)),
                ("Target (high)", fmt_num(f.get("target_high"), 2)),
                ("Target (low)",  fmt_num(f.get("target_low"), 2)),
                ("# Analysts",    fmt_num(f.get("num_analysts"), 0)),
            ])

        # Business summary + key executives
        if f.get("summary"):
            with st.expander("Business summary"):
                st.write(f["summary"])
        officers = get_officers(ticker)
        if officers:
            with st.expander("Key executives"):
                for o in officers:
                    pay = human_number(o["pay"], cur) if o.get("pay") else "—"
                    st.markdown(
                        f'<div class="sma-row"><span class="tk" style="flex:1;">'
                        f'{o["name"]}</span><span class="nm" style="flex:2;">'
                        f'{o["title"]}</span><span>{pay}</span></div>',
                        unsafe_allow_html=True,
                    )

elif fn == "Technicals & charts":
    cv1, cv2, cv3, cv4 = st.columns([2, 3, 3, 1])
    period = cv1.segmented_control("Period", PERIOD_LABELS, default="1Y",
                                   key="tm_per") or "1Y"
    view = cv2.segmented_control(
        "View", ["Performance", "Price", "Candlestick", "Area"],
        default="Price", key="tm_view") or "Price"
    mas = cv3.multiselect("Moving averages", [20, 50, 100, 200],
                          default=[50, 200], key="tm_mas",
                          format_func=lambda w: f"SMA {w}")
    bb = cv4.toggle("Bollinger", value=False, key="tm_bb")
    hist = get_history(ticker, period)
    baseline = quote.get("prev_close") if period == "1D" else None
    st.plotly_chart(
        render_price_chart(hist, view=view, baseline_price=baseline,
                           show_volume=True, height=480, mas=mas, bollinger=bb),
        use_container_width=True,
    )
    ri1, ri2 = st.columns([1, 5])
    with ri1:
        show_rsi = st.toggle("Show RSI", value=False, key="tm_rsi")
        rsi_p = st.number_input("RSI period", 5, 30, 14, key="tm_rsi_p")
    if show_rsi:
        st.plotly_chart(render_rsi(hist, period=int(rsi_p), divergences=True),
                        use_container_width=True)

    with st.expander("Strategy backtest (educational, past data only)"):
        bt1, bt2, bt3, bt4 = st.columns(4)
        strat = bt1.selectbox("Strategy", ["SMA crossover", "RSI bands"],
                              key="tm_bt_strat")
        if strat == "SMA crossover":
            fast = bt2.number_input("Fast SMA", 5, 100, 50, key="tm_bt_fast")
            slow = bt3.number_input("Slow SMA", 20, 300, 200, key="tm_bt_slow")
            params, skey = {"fast": fast, "slow": slow}, "sma_cross"
        else:
            period_rsi = bt2.number_input("RSI period", 5, 30, 14, key="tm_bt_rp")
            low  = bt3.number_input("Buy below", 5, 50, 30, key="tm_bt_low")
            high = bt4.number_input("Sell above", 50, 95, 70, key="tm_bt_high")
            params, skey = {"period": period_rsi, "low": low, "high": high}, "rsi"
        bt_hist = get_history(ticker, "5Y")
        result = run_backtest(bt_hist, skey, params)
        if not result:
            st.caption("Not enough history to backtest this ticker.")
        else:
            s = result["stats"]
            sc = st.columns(5)
            sc[0].metric("Strategy return", f"{s['total_return_pct']:+.1f}%")
            sc[1].metric("Buy & hold",      f"{s['buy_hold_pct']:+.1f}%")
            sc[2].metric("Max drawdown",    f"{s['max_drawdown_pct']:.1f}%")
            sc[3].metric("Sharpe",          f"{s['sharpe']:.2f}")
            sc[4].metric("Trades",          f"{s['trades']}")
            st.plotly_chart(render_backtest_chart(result), use_container_width=True)
            st.caption("Past simulation only. Not advice and not predictive. "
                       "Excludes fees, slippage, and taxes.")

elif fn == "Financials":
    freq = st.segmented_control("Period", ["Annual", "Quarterly"],
                                default="Annual", key="tm_freq") or "Annual"
    quarterly = freq == "Quarterly"
    CONFIG = {
        "Income":      ("income",   INCOME_ROWS,   ["Total Revenue", "Net Income"]),
        "Balance":     ("balance",  BALANCE_ROWS,
                        ["Total Assets", "Total Liabilities Net Minority Interest"]),
        "Cash flow":   ("cashflow", CASHFLOW_ROWS, ["Operating Cash Flow", "Free Cash Flow"]),
    }
    tabs = st.tabs(list(CONFIG.keys()))
    for tab, (label, (kind, rows, chart_rows)) in zip(tabs, CONFIG.items()):
        with tab:
            df = select_rows(get_statement(ticker, kind, quarterly), rows)
            if df.empty:
                st.caption("Statement data unavailable.")
                continue
            cols_chrono = list(df.columns)[::-1]
            fig = go.Figure()
            palette = ["#ffb000", "#22d3ee", "#e879f9"]
            for i, r in enumerate([r for r in chart_rows if r in df.index]):
                fig.add_trace(go.Bar(
                    x=cols_chrono, y=[df.loc[r, c] for c in cols_chrono],
                    name=r, marker_color=palette[i % len(palette)]))
            fig.update_layout(template="plotly_dark", height=320, barmode="group",
                              paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                              font=dict(family="JetBrains Mono, monospace",
                                        color="#cdd1d8"),
                              margin=dict(l=10, r=10, t=10, b=10),
                              legend=dict(orientation="h", y=1.1))
            st.plotly_chart(fig, use_container_width=True)

            disp = df.copy()
            for c in disp.columns:
                disp[c] = disp[c].apply(
                    lambda v: human_number(v, cur) if v is not None else "—")
            st.dataframe(disp, use_container_width=True)
            download_csv_button(
                df, f"{ticker}_{kind}_{'q' if quarterly else 'a'}.csv",
                key=f"dl_fin_{kind}", index=True)

elif fn == "Estimates & targets":
    est = get_estimates(ticker)
    if not est:
        st.caption("Estimate data unavailable for this ticker.")
    pt = est.get("price_targets")
    if isinstance(pt, dict) and pt:
        pc = st.columns(4)
        pc[0].metric("Target mean", f"{cur}{pt.get('mean', '—')}")
        pc[1].metric("Target high", f"{cur}{pt.get('high', '—')}")
        pc[2].metric("Target low",  f"{cur}{pt.get('low', '—')}")
        pc[3].metric("Current",     f"{cur}{pt.get('current', '—')}")
    for key, title in (("earnings_estimate", "Earnings estimates"),
                       ("revenue_estimate",  "Revenue estimates"),
                       ("growth_estimates",  "Growth estimates")):
        if key in est:
            st.markdown(f"**{title}**")
            st.dataframe(est[key], use_container_width=True)

elif fn == "Capital structure":
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
                 "Total debt":       cap.get("total_debt"),
                 "Cash":             cap.get("cash")}
        parts = {k: v for k, v in parts.items() if v}
        if parts:
            fig = go.Figure(go.Bar(
                x=list(parts.keys()), y=list(parts.values()),
                marker_color=["#22d3ee", "#ff4d4f", "#1fd286"]))
            fig.update_layout(template="plotly_dark", height=300,
                              paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                              font=dict(family="JetBrains Mono, monospace",
                                        color="#cdd1d8"),
                              margin=dict(l=10, r=10, t=10, b=10))
            st.plotly_chart(fig, use_container_width=True)

    # Value-investing add-on: Graham + Buffett checklists (folded in from the
    # old Value Investing page, since they're capital-structure / quality
    # views of the same name).
    st.subheader("Graham valuation")
    g1, g2, g3 = st.columns(3)
    eps = g1.number_input("EPS (trailing)", value=float(f.get("eps_trailing") or 0.0),
                          step=0.5, format="%.2f", key="tm_g_eps")
    default_growth = (f.get("earnings_growth") or f.get("revenue_growth") or 0.0) * 100
    growth = g2.number_input("Expected growth % (annual)",
                             value=round(float(default_growth), 1), step=1.0,
                             key="tm_g_gr")
    bond_yield = g3.number_input("High-grade bond yield %", value=7.0, step=0.25,
                                 key="tm_g_by")
    intrinsic = graham_intrinsic_value(eps, growth, bond_yield)
    mos = margin_of_safety(intrinsic, price)
    mv1, mv2, mv3 = st.columns(3)
    mv1.metric("Live price", f"{cur}{fmt_num(price, 2)}")
    mv2.metric("Graham intrinsic value",
               f"{cur}{fmt_num(intrinsic, 2)}" if intrinsic else "—")
    mv3.metric("Margin of safety",
               f"{mos:+.1f}%" if mos is not None else "—",
               delta="Undervalued" if (mos or 0) > 0 else "Overvalued"
               if mos is not None else None)
    st.caption("Graham's formula is a rough rule of thumb; very sensitive to "
               "the growth and yield inputs. Educational only.")

    st.subheader("Buffett-style quality checklist")
    items, summary = buffett_checklist(f, intrinsic, price)
    sc1, sc2 = st.columns([1, 2])
    with sc1:
        st.plotly_chart(quality_gauge(summary["score"], "Tenets met",
                                      f"{summary['pass']}/{summary['scored']} pass"),
                        use_container_width=True)
    with sc2:
        st.markdown(
            f"Passing **{summary['pass']}**, warnings **{summary['warn']}**, "
            f"failing **{summary['fail']}** of {summary['scored']} scored tenets.")
        st.caption("Descriptive scorecard of classic quality/value tenets — "
                   "not a recommendation.")
    _status_color = {"pass": ("PASS", "#1fd286"), "warn": ("WARN", "#ffb000"),
                     "fail": ("FAIL", "#ff4d4f"), "na": ("N/A", "#767c88")}
    cats_cols = st.columns(2)
    for idx, cat in enumerate(["Business", "Management", "Financial", "Value"]):
        with cats_cols[idx % 2]:
            st.markdown(f"**{cat}**")
            for it in [i for i in items if i["category"] == cat]:
                label, color = _status_color[it["status"]]
                st.markdown(
                    f'<div class="sma-chip" style="border-left-color:{color};">'
                    f'<span class="lab">{it["criterion"]}</span>'
                    f'<span class="val" style="color:{color};">{label}</span></div>'
                    f'<div style="font-size:11px;color:#767c88;margin:-2px 0 6px 2px;">'
                    f'{it["detail"]}</div>',
                    unsafe_allow_html=True,
                )

elif fn == "Comparables":
    st.caption("Compare against peers across valuation multiples. "
               "EV/EBITDA uses market cap as an EV proxy (no debt-layer feed).")
    peers_raw = st.text_input(
        "Peer tickers (comma-separated)",
        value=f"{ticker}, TCS.NS, INFY.NS, WIPRO.NS", key="tm_peers_in",
    )
    peers = [p.strip().upper() for p in peers_raw.split(",") if p.strip()]
    if peers:
        comps = comps_matrix(peers)
        st.dataframe(comps, use_container_width=True, hide_index=True)
        download_csv_button(comps, f"{ticker}_comps.csv", key="dl_comps")

elif fn == "Debt profile":
    st.caption("Free data exposes debt levels and ratios, not a "
               "maturity-by-year schedule.")
    bs = select_rows(get_statement(ticker, "balance"),
                     ["Total Debt", "Long Term Debt", "Current Debt"])
    total_debt = (bs.loc["Total Debt"].iloc[0]
                  if (not bs.empty and "Total Debt" in bs.index) else None)
    de = f.get("debt_to_equity")
    d = st.columns(4)
    d[0].metric("Total debt",    human_number(total_debt, cur))
    d[1].metric("Debt / Equity", f"{de/100:.2f}x" if de is not None else "—")
    d[2].metric("Current ratio", fmt_num(f.get("current_ratio"), 2))
    d[3].metric("Quick ratio",   fmt_num(f.get("quick_ratio"), 2))
    if not bs.empty:
        disp = bs.copy()
        for c in disp.columns:
            disp[c] = disp[c].apply(
                lambda v: human_number(v, cur) if v is not None else "—")
        st.dataframe(disp, use_container_width=True)

elif fn == "Ownership / insiders":
    own = get_ownership(ticker)
    if not own["major_holders"].empty:
        st.markdown("**Ownership summary**")
        st.dataframe(own["major_holders"], use_container_width=True)
    if not own["institutional_holders"].empty:
        st.markdown("**Top institutional holders**")
        st.dataframe(own["institutional_holders"],
                     use_container_width=True, hide_index=True)
    if not own["mutualfund_holders"].empty:
        st.markdown("**Top mutual-fund holders**")
        st.dataframe(own["mutualfund_holders"],
                     use_container_width=True, hide_index=True)
    if all(own[k].empty for k in own):
        st.caption("Ownership data unavailable for this ticker.")

elif fn == "Earnings history":
    eh = get_earnings_history(ticker)
    if eh.empty:
        st.caption("Earnings history unavailable.")
    else:
        st.dataframe(eh, use_container_width=True)
        cols = {c.lower(): c for c in eh.columns}
        act, est_c = cols.get("epsactual"), cols.get("epsestimate")
        if act and est_c:
            d = eh.dropna(subset=[act, est_c])
            fig = go.Figure()
            fig.add_trace(go.Bar(x=[str(i) for i in d.index], y=d[est_c],
                                 name="Estimate", marker_color="#6b7280"))
            fig.add_trace(go.Bar(x=[str(i) for i in d.index], y=d[act],
                                 name="Actual",   marker_color="#ffb000"))
            fig.update_layout(template="plotly_dark", height=320, barmode="group",
                              paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                              font=dict(family="JetBrains Mono, monospace",
                                        color="#cdd1d8"),
                              margin=dict(l=10, r=10, t=10, b=10))
            st.plotly_chart(fig, use_container_width=True)

elif fn == "Street ratings":
    r = get_ratings(ticker)
    tp = r.get("targets") or {}
    if isinstance(tp, dict) and tp:
        m = st.columns(4)
        m[0].metric("Mean target", f"{cur}{tp.get('mean','—')}")
        m[1].metric("High",        f"{cur}{tp.get('high','—')}")
        m[2].metric("Low",         f"{cur}{tp.get('low','—')}")
        m[3].metric("Current",     f"{cur}{tp.get('current','—')}")
    rec = r.get("recommendations")
    if rec is not None and not rec.empty:
        st.markdown("**Recommendation trend**")
        st.dataframe(rec, use_container_width=True, hide_index=True)
    elif not (isinstance(tp, dict) and tp):
        st.caption("Analyst rating data unavailable for this ticker.")

elif fn == "WACC model":
    st.caption("Weighted Average Cost of Capital. Inputs are adjustable; "
               "equity value, debt, and beta are pre-filled where available.")
    bs = select_rows(get_statement(ticker, "balance"), ["Total Debt"])
    debt_default = float(bs.iloc[0, 0]) if not bs.empty else 0.0
    e1, e2, e3 = st.columns(3)
    equity = e1.number_input("Equity value (market cap)",
                             value=float(f.get("market_cap") or 0.0),
                             step=1e9, key="tm_wacc_e")
    debt = e2.number_input("Total debt", value=debt_default, step=1e9,
                           key="tm_wacc_d")
    beta = e3.number_input("Beta", value=float(f.get("beta") or 1.0),
                           step=0.05, key="tm_wacc_b")
    e4, e5, e6 = st.columns(3)
    rf       = e4.number_input("Risk-free rate %",      value=7.0, step=0.25, key="tm_wacc_rf")
    erp      = e5.number_input("Equity risk premium %", value=6.0, step=0.25, key="tm_wacc_erp")
    cost_dbt = e6.number_input("Pre-tax cost of debt %", value=8.0, step=0.25, key="tm_wacc_cd")
    tax = st.slider("Tax rate %", 0, 50, 25, key="tm_wacc_tax")
    re_ = capm_cost_of_equity(rf, beta, erp)
    res = wacc(equity, debt, re_, cost_dbt, tax)
    w = st.columns(3)
    w[0].metric("Cost of equity (CAPM)", f"{re_:.2f}%")
    w[1].metric("Capital weights (E / D)",
                f"{res['we']:.0f}% / {res['wd']:.0f}%"
                if res["we"] is not None else "—")
    w[2].metric("WACC",
                f"{res['wacc']:.2f}%" if res["wacc"] is not None else "—")

elif fn == "Value-chain map":
    company_name = f.get("name", ticker)
    provider = ai_analyst.active_provider()
    st.caption(
        f"Educational map generated by **{provider}** — general knowledge, "
        "not sourced market data. Cached 12 h per ticker."
    )
    if not ai_analyst.is_available():
        st.info(
            "No AI key configured. Add **GROQ_API_KEY** (free at "
            "[console.groq.com](https://console.groq.com)) to your `.env` "
            "or Streamlit secrets — 14 400 free calls/day, no card."
        )
    else:
        col_btn, col_clr = st.columns([2, 1])
        gen_btn = col_btn.button("Map value chain", key="vc_gen",
                                 use_container_width=True)
        if col_clr.button("Clear cache", key="vc_clear",
                          use_container_width=True):
            vc.get_chain_data.clear()
            st.rerun()
        run_now = gen_btn or st.session_state.get(f"vc_loaded_{ticker}", False)
        if run_now:
            st.session_state[f"vc_loaded_{ticker}"] = True
            with st.spinner("Building value-chain map…"):
                try:
                    data = vc.get_chain_data(ticker, company_name)
                    if not data:
                        st.warning("Could not parse a structured response.")
                    else:
                        fig = vc.build_chain_figure(ticker, company_name, data)
                        st.plotly_chart(fig, use_container_width=True,
                                        config={"displayModeBar": False})
                        with st.expander("Supplier details"):
                            for s in data.get("suppliers", []):
                                st.markdown(f"**{s.get('name','')}** — {s.get('note','')}")
                        with st.expander("Customer details"):
                            for c in data.get("customers", []):
                                st.markdown(f"**{c.get('name','')}** — {c.get('note','')}")
                        with st.expander("Competitor details"):
                            for cp in data.get("competitors", []):
                                st.markdown(f"**{cp.get('name','')}** — {cp.get('note','')}")
                except ai_analyst.AnalystError as e:
                    st.error(f"AI error: {e}")

elif fn == "Options & Greeks":
    st.caption("Implied vol from the market; Greeks computed via Black-Scholes. "
               "Yahoo's option coverage is US-centric — Indian (.NS) tickers "
               "usually have no chain here.")
    o1, o2, o3 = st.columns([2, 2, 1])
    r_input = o3.number_input("Risk-free %", 0.0, 15.0, 5.0,
                              step=0.25, key="tm_opt_r") / 100.0
    expiries = get_expiries(ticker)
    if not expiries:
        st.warning(f"No listed options found for '{ticker}'.")
    else:
        with o2:
            expiry = st.selectbox("Expiry", expiries, key="tm_opt_exp")
        S = quote.get("price")
        if S is None:
            st.error("Could not load the underlying price.")
        else:
            T = years_to_expiry(expiry)
            chain = get_option_chain(ticker, expiry)
            calls = enrich_with_greeks(chain["calls"], S, T, r_input, "call")
            puts  = enrich_with_greeks(chain["puts"],  S, T, r_input, "put")
            mp = max_pain(chain["calls"], chain["puts"])
            atm_iv = None
            try:
                ci = calls.iloc[(calls["strike"] - S).abs().argsort()[:1]]["impliedVolatility"].iloc[0]
                pi = puts.iloc[(puts["strike"]  - S).abs().argsort()[:1]]["impliedVolatility"].iloc[0]
                atm_iv = (ci + pi) / 2 * 100
            except Exception:
                pass
            m = st.columns(4)
            m[0].metric("Spot", f"{cur}{fmt_num(S, 2)}",
                        delta=f"{quote.get('change_pct'):+.2f}%"
                        if quote.get("change_pct") else None)
            m[1].metric("Days to expiry",    f"{T * 365:.0f}")
            m[2].metric("ATM implied vol",   f"{atm_iv:.1f}%" if atm_iv is not None else "—")
            m[3].metric("Max pain",          f"{cur}{fmt_num(mp, 2)}" if mp is not None else "—")

            st.subheader("Implied-volatility smile")
            fig = go.Figure()
            if not calls.empty:
                fig.add_trace(go.Scatter(x=calls["strike"],
                                         y=calls["impliedVolatility"] * 100,
                                         mode="lines+markers", name="Calls",
                                         line=dict(color="#1fd286")))
            if not puts.empty:
                fig.add_trace(go.Scatter(x=puts["strike"],
                                         y=puts["impliedVolatility"] * 100,
                                         mode="lines+markers", name="Puts",
                                         line=dict(color="#ff4d4f")))
            fig.add_vline(x=S, line=dict(color="#ffb000", width=1, dash="dot"))
            fig.update_layout(template="plotly_dark", height=360,
                              paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                              font=dict(family="JetBrains Mono, monospace",
                                        color="#cdd1d8"),
                              margin=dict(l=10, r=10, t=10, b=10),
                              xaxis_title="Strike", yaxis_title="IV %",
                              legend=dict(orientation="h", y=1.1))
            st.plotly_chart(fig, use_container_width=True)

            COLS = ["strike", "lastPrice", "bid", "ask", "impliedVolatility",
                    "volume", "openInterest", "delta", "gamma", "theta", "vega", "rho"]
            RENAME = {"lastPrice": "last", "impliedVolatility": "IV",
                      "openInterest": "OI"}

            def show_chain(title, df, near=20):
                st.markdown(f"**{title}**")
                if df is None or df.empty:
                    st.caption("No data.")
                    return
                sub = df.iloc[(df["strike"] - S).abs().argsort()[:near]].sort_values("strike")
                cols = [c for c in COLS if c in sub.columns]
                disp = sub[cols].copy()
                if "impliedVolatility" in disp:
                    disp["impliedVolatility"] = (disp["impliedVolatility"] * 100).round(1)
                for g in ("delta", "gamma", "theta", "vega", "rho", "bs_price"):
                    if g in disp:
                        disp[g] = disp[g].round(3)
                disp = disp.rename(columns=RENAME)
                st.dataframe(disp, use_container_width=True, hide_index=True)

            ot1, ot2 = st.tabs(["Calls", "Puts"])
            with ot1:
                show_chain("Near-the-money calls", calls)
            with ot2:
                show_chain("Near-the-money puts", puts)

elif fn == "ETF profile":
    if not etf:
        st.info("This ticker isn't recognised as an ETF.")
    else:
        details = get_etf_details(ticker)
        er = details.get("expense_ratio")
        er_pct = (er * 100 if er is not None and er < 1 else er)
        hist_3y = get_history(ticker, "3Y")

        m = st.columns(4)
        m[0].metric("Expense ratio",
                    f"{er_pct:.2f}%" if er_pct is not None else "—")
        m[1].metric("Total assets", human_number(details.get("total_assets"), cur))
        m[2].metric("Yield",
                    fmt_pct((details.get("yield") or 0) * 100)
                    if details.get("yield") is not None else "—")
        m[3].metric("3-yr beta", fmt_num(details.get("beta_3y"), 2))

        rc1, rc2 = st.columns([3, 2])
        with rc1:
            st.subheader("Returns")
            def _p(v): return fmt_pct(v * 100) if v is not None else "—"
            st.markdown(
                f'<div class="sma-chip"><span class="lab">YTD return</span>'
                f'<span class="val">{_p(details.get("ytd_return"))}</span></div>'
                f'<div class="sma-chip"><span class="lab">3-yr avg (ann.)</span>'
                f'<span class="val">{_p(details.get("three_year_return"))}</span></div>'
                f'<div class="sma-chip"><span class="lab">5-yr avg (ann.)</span>'
                f'<span class="val">{_p(details.get("five_year_return"))}</span></div>',
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
                bits.append(f"Top-10 conc. {comp['top10_concentration_pct']}%")
            if bits:
                st.caption(" · ".join(bits))

        sectors = details.get("sector_weights") or {}
        if sectors:
            st.subheader("Sector breakdown")
            items = sorted(sectors.items(), key=lambda kv: kv[1], reverse=True)
            fig = go.Figure(go.Bar(
                x=[v * 100 for _, v in items],
                y=[k for k, _ in items],
                orientation="h", marker_color="#ffae00",
                text=[f"{v * 100:.1f}%" for _, v in items],
                textposition="outside",
            ))
            fig.update_layout(template="plotly_dark", height=360,
                              paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                              font=dict(family="JetBrains Mono, monospace",
                                        color="#cdd1d8"),
                              margin=dict(l=10, r=40, t=10, b=10),
                              yaxis=dict(autorange="reversed"),
                              xaxis_title="Weight %")
            st.plotly_chart(fig, use_container_width=True)

        holdings = details.get("holdings") or []
        if holdings:
            st.subheader("Top holdings")
            cols = st.columns(2)
            for i, h in enumerate(holdings[:10]):
                sym = h.get("symbol", "")
                w_ = h.get("weight")
                with cols[i % 2]:
                    st.markdown(
                        f'<div class="sma-row">{logo_img_html(sym, 26)}'
                        f'<span class="tk">{sym}</span>'
                        f'<span class="nm" style="flex:1;">{h.get("name","")}</span>'
                        f'<span class="val">{w_ * 100:.2f}%</span></div>'
                        if w_ is not None else
                        f'<div class="sma-row">{logo_img_html(sym, 26)}'
                        f'<span class="tk">{sym}</span>'
                        f'<span class="nm" style="flex:1;">{h.get("name","")}</span></div>',
                        unsafe_allow_html=True,
                    )

elif fn == "Peer cost comparison":
    if not etf:
        st.info("This view is for ETFs only.")
    else:
        details = get_etf_details(ticker)
        er = details.get("expense_ratio")
        current_er = (er * 100 if er is not None and er < 1 else er)
        peers = get_peers(ticker)
        if len(peers) <= 1:
            st.caption("No comparable peer set found for this ETF.")
        else:
            peer_rows = []
            for p in peers:
                d = get_etf_details(p)
                pe_er = d.get("expense_ratio")
                pe_er = (pe_er * 100 if pe_er is not None and pe_er < 1 else pe_er)
                peer_rows.append({
                    "ticker": p, "name": d.get("name", p),
                    "er": pe_er, "assets": d.get("total_assets"),
                })
            peer_rows.sort(key=lambda r: (r["er"] is None, r["er"] or 0))
            header = (
                '<div class="sma-row" style="font-weight:700;color:#94a3b8;">'
                '<span style="flex:0 0 70px;">Ticker</span>'
                '<span style="flex:1;">Name</span>'
                '<span style="flex:0 0 110px;text-align:right;">Expense ratio</span>'
                '<span style="flex:0 0 110px;text-align:right;">Assets</span></div>'
            )
            body = []
            for r in peer_rows:
                mark = " (current)" if r["ticker"] == ticker else ""
                er_txt = f"{r['er']:.2f}%" if r["er"] is not None else "—"
                body.append(
                    f'<div class="sma-row">'
                    f'<span style="flex:0 0 70px;" class="tk">{r["ticker"]}{mark}</span>'
                    f'<span style="flex:1;">{r["name"]}</span>'
                    f'<span style="flex:0 0 110px;text-align:right;">{er_txt}</span>'
                    f'<span style="flex:0 0 110px;text-align:right;">{human_number(r["assets"], "$")}</span></div>'
                )
            st.markdown(header + "".join(body), unsafe_allow_html=True)

            cheaper = [r for r in peer_rows
                       if r["er"] is not None and current_er is not None
                       and r["er"] < current_er]
            if cheaper:
                best = cheaper[0]
                bps = (current_er - best["er"]) * 100
                dollars = (current_er - best["er"]) / 100 * 100_000
                st.info(
                    f"**{best['ticker']}** has a lower expense ratio than "
                    f"**{ticker}** ({best['er']:.2f}% vs {current_er:.2f}%) — "
                    f"about **{bps:.0f} bps** cheaper, or roughly "
                    f"**${dollars:,.0f}/yr** on a $100K position. Educational "
                    "cost comparison, not a recommendation."
                )

elif fn == "AI deep-dive":
    tech_ctx = {}
    if not etf:
        hist_1y = get_history(ticker, "1Y")
        tech_score, tech_drivers, _ = compute_technical_score(hist_1y, f)
        fund_score, _, _ = compute_fundamental_score(f)
        tech_ctx = {"technical_score": tech_score,
                    "fundamental_score": fund_score, "drivers": tech_drivers}

    if not ai_analyst.is_available():
        st.info("Add GROQ_API_KEY (free at console.groq.com) or "
                "GEMINI_API_KEY to your .env / Streamlit secrets.")
    else:
        provider = ai_analyst.active_provider()
        st.caption(f"Using **{provider}**.")
        ta1, ta2 = st.tabs(["Bull / Bear case", "Deep analysis"])
        with ta1:
            if st.button("Generate bull / bear case", key="tm_bb_btn"):
                with st.spinner("Thinking…"):
                    try:
                        st.markdown(ai_analyst.bull_bear_case(ticker, f, tech_ctx))
                    except ai_analyst.AnalystError as e:
                        st.error(f"AI error: {e}")
        with ta2:
            if st.button("Generate deep analysis", key="tm_deep_btn"):
                with st.spinner("Thinking…"):
                    try:
                        st.markdown(ai_analyst.deep_analysis(ticker, f, tech_ctx))
                    except ai_analyst.AnalystError as e:
                        st.error(f"AI error: {e}")

elif fn == "Recent news":
    items = ticker_news(ticker, limit=12)
    if not items:
        st.caption("No recent headlines found.")
    for n in items:
        st.markdown(
            f'<div class="sma-news">'
            f'<a href="{n.get("link","#")}" target="_blank">{n["title"]}</a>'
            f'<div class="meta">{n.get("publisher","")} · '
            f'{time_ago(n.get("published"))}</div>'
            f'<div class="sum">{(n.get("summary") or "")[:200]}</div></div>',
            unsafe_allow_html=True,
        )

disclosure()
