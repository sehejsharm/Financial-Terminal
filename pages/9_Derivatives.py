"""Derivatives - option chains with Black-Scholes Greeks, IV smile, max pain."""
import plotly.graph_objects as go
import streamlit as st

from lib.market_data import get_quote
from lib.options import (
    enrich_with_greeks,
    get_expiries,
    get_option_chain,
    max_pain,
    years_to_expiry,
)
from lib.ui import cur_symbol, disclosure, fmt_num, setup_page, ticker_picker

setup_page("Derivatives")
st.title("Derivatives - Options & Greeks")
st.caption("Implied vol is from the market; Greeks are computed via "
           "Black-Scholes. Yahoo's option coverage is US-centric, so use US "
           "tickers (e.g. AAPL, SPY, TSLA) for full chains. Educational only.")

c1, c2, c3 = st.columns([2, 2, 1])
with c1:
    ticker = ticker_picker("Search security", default="AAPL", key="dv_pick")
with c3:
    r = st.number_input("Risk-free %", 0.0, 15.0, 5.0, step=0.25) / 100.0

if not ticker:
    st.info("Enter a ticker to begin.")
    st.stop()

expiries = get_expiries(ticker)
if not expiries:
    st.warning(f"No listed options found for '{ticker}'. Yahoo provides option "
               "chains mainly for US-listed names; Indian (.NS) tickers usually "
               "have none here.")
    disclosure()
    st.stop()

with c2:
    expiry = st.selectbox("Expiry", expiries, key="dv_exp")

quote = get_quote(ticker)
S = quote.get("price")
cur = cur_symbol(quote.get("currency"))
if S is None:
    st.error("Could not load the underlying price.")
    st.stop()

T = years_to_expiry(expiry)
chain = get_option_chain(ticker, expiry)
calls = enrich_with_greeks(chain["calls"], S, T, r, "call")
puts = enrich_with_greeks(chain["puts"], S, T, r, "put")
mp = max_pain(chain["calls"], chain["puts"])

# ATM IV (closest strike to spot, averaged across call/put).
atm_iv = None
try:
    ci = calls.iloc[(calls["strike"] - S).abs().argsort()[:1]]["impliedVolatility"].iloc[0]
    pi = puts.iloc[(puts["strike"] - S).abs().argsort()[:1]]["impliedVolatility"].iloc[0]
    atm_iv = (ci + pi) / 2 * 100
except Exception:
    pass

m1, m2, m3, m4 = st.columns(4)
m1.metric("Spot", f"{cur}{fmt_num(S, 2)}",
          delta=f"{quote.get('change_pct'):+.2f}%" if quote.get("change_pct") else None)
m2.metric("Days to expiry", f"{T * 365:.0f}")
m3.metric("ATM implied vol", f"{atm_iv:.1f}%" if atm_iv is not None else "—")
m4.metric("Max pain", f"{cur}{fmt_num(mp, 2)}" if mp is not None else "—")

# ---- IV smile -----------------------------------------------------------
st.subheader("Implied volatility smile")
fig = go.Figure()
if not calls.empty:
    fig.add_trace(go.Scatter(x=calls["strike"], y=calls["impliedVolatility"] * 100,
                             mode="lines+markers", name="Calls",
                             line=dict(color="#1fd286")))
if not puts.empty:
    fig.add_trace(go.Scatter(x=puts["strike"], y=puts["impliedVolatility"] * 100,
                             mode="lines+markers", name="Puts",
                             line=dict(color="#ff4d4f")))
fig.add_vline(x=S, line=dict(color="#ffb000", width=1, dash="dot"))
fig.update_layout(template="plotly_dark", height=360,
                  paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                  font=dict(family="JetBrains Mono, monospace", color="#cdd1d8"),
                  margin=dict(l=10, r=10, t=10, b=10),
                  xaxis_title="Strike", yaxis_title="IV %",
                  legend=dict(orientation="h", y=1.1))
st.plotly_chart(fig, use_container_width=True)

# ---- Chains with Greeks -------------------------------------------------
COLS = ["strike", "lastPrice", "bid", "ask", "impliedVolatility", "volume",
        "openInterest", "delta", "gamma", "theta", "vega", "rho"]
RENAME = {"lastPrice": "last", "impliedVolatility": "IV", "openInterest": "OI"}


def show_chain(title: str, df, near=20):
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


st.subheader("Calls")
show_chain("Near-the-money calls", calls)
st.subheader("Puts")
show_chain("Near-the-money puts", puts)

disclosure()
