"""Terminal - institutional analytics modules (Motherboard naming)."""
import plotly.graph_objects as go
import streamlit as st

from lib import ai_analyst
from lib.charts import render_price_chart
from lib.fundamentals import (
    BALANCE_ROWS,
    CASHFLOW_ROWS,
    INCOME_ROWS,
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
from lib.market_data import get_history, get_quote, get_stock_fundamentals
from lib.ui import (
    cur_symbol,
    disclosure,
    fmt_num,
    human_number,
    setup_page,
    ticker_picker,
)

setup_page("Terminal")
st.title("Terminal")

MODULES = [
    "Company Snapshot", "Comps Matrix", "Debt Profile", "Deep Financials",
    "Consensus Projections", "Earnings Track", "Cap Table & Block Holdings",
    "Historical Price Action", "Street Ratings", "Capital Cost Model",
    "Value Chain Mapper", "Motherboard Screener",
]
LEGACY = {
    "Company Snapshot": "DES", "Comps Matrix": "RV", "Debt Profile": "DDIS",
    "Deep Financials": "FA", "Consensus Projections": "EE", "Earnings Track": "ERN",
    "Cap Table & Block Holdings": "OWN/HDS", "Historical Price Action": "GP",
    "Street Ratings": "ANR", "Capital Cost Model": "WACC",
    "Value Chain Mapper": "SPLC", "Motherboard Screener": "EQS",
}

c1, c2 = st.columns([2, 2])
with c1:
    ticker = ticker_picker("Search security", default="RELIANCE.NS", key="tm_pick")
with c2:
    module = st.selectbox("Function", MODULES,
                          format_func=lambda m: f"{m}")

if not ticker:
    st.stop()

f = get_stock_fundamentals(ticker)
quote = get_quote(ticker)
cur = cur_symbol(f.get("currency") or quote.get("currency"))
st.markdown(f"### {f.get('name', ticker)}  ·  {module}")
st.caption(f"{ticker} · legacy code: {LEGACY[module]}")


def _statement_block(kind, rows):
    df = select_rows(get_statement(ticker, kind), rows)
    if df.empty:
        st.caption("Statement unavailable.")
        return
    disp = df.copy()
    for c in disp.columns:
        disp[c] = disp[c].apply(lambda v: human_number(v, cur) if v is not None else "—")
    st.dataframe(disp, use_container_width=True)


# ---- Module rendering ---------------------------------------------------
if module == "Company Snapshot":
    m = st.columns(4)
    m[0].metric("Price", f"{cur}{fmt_num(f.get('price') or quote.get('price'), 2)}")
    m[1].metric("Market cap", human_number(f.get("market_cap"), cur))
    m[2].metric("Trailing P/E", fmt_num(f.get("trailing_pe"), 1))
    m[3].metric("Beta", fmt_num(f.get("beta"), 2))
    st.markdown(f"**Sector / Industry:** {f.get('sector') or '—'} / "
                f"{f.get('industry') or '—'}")
    if f.get("summary"):
        st.markdown("**Business**")
        st.write(f["summary"])
    officers = get_officers(ticker)
    if officers:
        st.markdown("**Key executives**")
        for o in officers:
            pay = human_number(o["pay"], cur) if o.get("pay") else "—"
            st.markdown(f'<div class="sma-row"><span class="tk" style="flex:1;">'
                        f'{o["name"]}</span><span class="nm" style="flex:2;">'
                        f'{o["title"]}</span><span>{pay}</span></div>',
                        unsafe_allow_html=True)

elif module == "Comps Matrix":
    st.caption("Compare against peers across valuation multiples. "
               "EV/EBITDA uses market cap as an EV proxy (no debt-layer feed).")
    peers_raw = st.text_input("Peer tickers (comma-separated)",
                              value=f"{ticker}, TCS.NS, INFY.NS, WIPRO.NS")
    peers = [p.strip().upper() for p in peers_raw.split(",") if p.strip()]
    if peers:
        st.dataframe(comps_matrix(peers), use_container_width=True, hide_index=True)

elif module == "Debt Profile":
    st.caption("Free data exposes debt levels, not a maturity-by-year schedule. "
               "Shown below: debt levels and leverage ratios.")
    bs = select_rows(get_statement(ticker, "balance"),
                     ["Total Debt", "Long Term Debt", "Current Debt"])
    total_debt = None
    if not bs.empty and "Total Debt" in bs.index:
        total_debt = bs.loc["Total Debt"].iloc[0]
    de = f.get("debt_to_equity")
    d1, d2, d3, d4 = st.columns(4)
    d1.metric("Total debt", human_number(total_debt, cur))
    d2.metric("Debt / Equity", f"{de/100:.2f}x" if de is not None else "—")
    d3.metric("Current ratio", fmt_num(f.get("current_ratio"), 2))
    d4.metric("Quick ratio", fmt_num(f.get("quick_ratio"), 2))
    if not bs.empty:
        disp = bs.copy()
        for c in disp.columns:
            disp[c] = disp[c].apply(lambda v: human_number(v, cur) if v is not None else "—")
        st.dataframe(disp, use_container_width=True)

elif module == "Deep Financials":
    t1, t2, t3 = st.tabs(["Income", "Balance sheet", "Cash flow"])
    with t1:
        _statement_block("income", INCOME_ROWS)
    with t2:
        _statement_block("balance", BALANCE_ROWS)
    with t3:
        _statement_block("cashflow", CASHFLOW_ROWS)

elif module == "Consensus Projections":
    est = get_estimates(ticker)
    if not est:
        st.caption("Estimate data unavailable for this ticker.")
    for key, title in (("earnings_estimate", "EPS estimates"),
                       ("revenue_estimate", "Revenue estimates"),
                       ("growth_estimates", "Growth estimates")):
        if key in est:
            st.markdown(f"**{title}**")
            st.dataframe(est[key], use_container_width=True)

elif module == "Earnings Track":
    eh = get_earnings_history(ticker)
    if eh.empty:
        st.caption("Earnings history unavailable.")
    else:
        st.dataframe(eh, use_container_width=True)
        cols = {c.lower(): c for c in eh.columns}
        act = cols.get("epsactual")
        est = cols.get("epsestimate")
        if act and est:
            d = eh.dropna(subset=[act, est])
            fig = go.Figure()
            fig.add_trace(go.Bar(x=[str(i) for i in d.index], y=d[est],
                                 name="Estimate", marker_color="#6b7280"))
            fig.add_trace(go.Bar(x=[str(i) for i in d.index], y=d[act],
                                 name="Actual", marker_color="#ffb000"))
            fig.update_layout(template="plotly_dark", height=320, barmode="group",
                              paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                              font=dict(family="JetBrains Mono, monospace",
                                        color="#cdd1d8"),
                              margin=dict(l=10, r=10, t=10, b=10))
            st.plotly_chart(fig, use_container_width=True)

elif module == "Cap Table & Block Holdings":
    own = get_ownership(ticker)
    if not own["major_holders"].empty:
        st.markdown("**Ownership summary**")
        st.dataframe(own["major_holders"], use_container_width=True)
    if not own["institutional_holders"].empty:
        st.markdown("**Top institutional holders**")
        st.dataframe(own["institutional_holders"], use_container_width=True,
                     hide_index=True)
    if not own["mutualfund_holders"].empty:
        st.markdown("**Top mutual-fund holders**")
        st.dataframe(own["mutualfund_holders"], use_container_width=True,
                     hide_index=True)
    if all(own[k].empty for k in own):
        st.caption("Ownership data unavailable for this ticker.")

elif module == "Historical Price Action":
    period = st.segmented_control("Range", ["1Y", "5Y", "10Y", "Max"],
                                  default="5Y", key="tm_gp") or "5Y"
    st.plotly_chart(render_price_chart(get_history(ticker, period), view="Area",
                                       height=460, title=ticker),
                    use_container_width=True)

elif module == "Street Ratings":
    r = get_ratings(ticker)
    tp = r.get("targets") or {}
    if isinstance(tp, dict) and tp:
        m = st.columns(4)
        m[0].metric("Mean target", f"{cur}{tp.get('mean','—')}")
        m[1].metric("High", f"{cur}{tp.get('high','—')}")
        m[2].metric("Low", f"{cur}{tp.get('low','—')}")
        m[3].metric("Current", f"{cur}{tp.get('current','—')}")
    rec = r.get("recommendations")
    if rec is not None and not rec.empty:
        st.markdown("**Recommendation trend**")
        st.dataframe(rec, use_container_width=True, hide_index=True)
    elif not (isinstance(tp, dict) and tp):
        st.caption("Analyst rating data unavailable for this ticker.")

elif module == "Capital Cost Model":
    st.caption("Estimate the Weighted Average Cost of Capital. Inputs are "
               "adjustable; equity value, debt and beta are pre-filled where "
               "available.")
    bs = select_rows(get_statement(ticker, "balance"), ["Total Debt"])
    debt_default = float(bs.iloc[0, 0]) if not bs.empty else 0.0
    e1, e2, e3 = st.columns(3)
    equity = e1.number_input("Equity value (market cap)",
                             value=float(f.get("market_cap") or 0.0), step=1e9)
    debt = e2.number_input("Total debt", value=debt_default, step=1e9)
    beta = e3.number_input("Beta", value=float(f.get("beta") or 1.0), step=0.05)
    e4, e5, e6 = st.columns(3)
    rf = e4.number_input("Risk-free rate %", value=7.0, step=0.25)
    erp = e5.number_input("Equity risk premium %", value=6.0, step=0.25)
    cost_debt = e6.number_input("Pre-tax cost of debt %", value=8.0, step=0.25)
    tax = st.slider("Tax rate %", 0, 50, 25)
    re = capm_cost_of_equity(rf, beta, erp)
    res = wacc(equity, debt, re, cost_debt, tax)
    w1, w2, w3 = st.columns(3)
    w1.metric("Cost of equity (CAPM)", f"{re:.2f}%")
    w2.metric("Capital weights (E / D)",
              f"{res['we']:.0f}% / {res['wd']:.0f}%" if res["we"] is not None else "—")
    w3.metric("Capital Cost (WACC)",
              f"{res['wacc']:.2f}%" if res["wacc"] is not None else "—")

elif module == "Value Chain Mapper":
    st.caption("No free feed maps supplier/customer revenue dependencies. This "
               "uses Gemini to generate an EDUCATIONAL overview of the likely "
               "value chain — descriptive, not sourced market data.")
    if not ai_analyst.is_available():
        st.info("Add your GEMINI_API_KEY to .env to enable this.")
    elif st.button("Generate value-chain overview"):
        with st.spinner("Asking Gemini..."):
            try:
                prompt = (
                    f"Give an educational overview of the value chain for "
                    f"{f.get('name', ticker)} ({ticker}). Cover likely key "
                    "suppliers, major customer segments, and main competitors, "
                    "and explain revenue dependencies. Note this is general "
                    "knowledge, not sourced data. Use Markdown with sections "
                    "'## Suppliers', '## Customers', '## Competitors'."
                )
                st.markdown(ai_analyst._call(prompt))
            except ai_analyst.AnalystError as e:
                st.error(f"AI error: {e}")

elif module == "Motherboard Screener":
    st.info("The full custom screener (add/remove fundamental filters) lives on "
            "the **Screeners** page → 'Custom (Motherboard Screener)' tab.")
    st.page_link("pages/7_Screeners.py", label="Open Screeners")

disclosure()
