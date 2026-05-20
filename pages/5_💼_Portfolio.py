"""Portfolio - holdings, value, allocation, sector mix, and risk."""
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from lib import claude_analyst
from lib.market_data import get_history, get_quote, get_stock_fundamentals
from lib.portfolio import load_portfolio, save_portfolio
from lib.risk import portfolio_risk_score
from lib.ui import (
    color_pct_html,
    disclosure,
    fmt_num,
    human_number,
    risk_gauge,
    setup_page,
)

setup_page("Portfolio", "💼")
st.title("💼 Portfolio")
st.caption("Holdings are saved locally to data/portfolio.json (gitignored).")

# ---- Editor -------------------------------------------------------------
existing = load_portfolio()
seed = pd.DataFrame(existing) if existing else pd.DataFrame(
    {"ticker": ["AAPL"], "shares": [10.0], "cost_basis": [150.0]}
)
for col in ("ticker", "shares", "cost_basis"):
    if col not in seed.columns:
        seed[col] = None

edited = st.data_editor(
    seed[["ticker", "shares", "cost_basis"]],
    num_rows="dynamic",
    use_container_width=True,
    column_config={
        "ticker": st.column_config.TextColumn("Ticker"),
        "shares": st.column_config.NumberColumn("Shares", min_value=0.0, step=1.0),
        "cost_basis": st.column_config.NumberColumn("Cost basis / share",
                                                    min_value=0.0, format="$%.2f"),
    },
    key="pf_editor",
)

if st.button("💾 Save portfolio"):
    save_portfolio(edited.to_dict("records"))
    st.success("Saved.")

# ---- Build holdings -----------------------------------------------------
holdings = []
for _, row in edited.iterrows():
    tk = str(row.get("ticker") or "").strip().upper()
    if not tk:
        continue
    try:
        shares = float(row.get("shares") or 0)
        cost = float(row.get("cost_basis") or 0)
    except (TypeError, ValueError):
        continue
    if shares <= 0:
        continue
    holdings.append({"ticker": tk, "shares": shares, "cost_basis": cost})

if not holdings:
    st.info("Add at least one holding with shares to see analytics.")
    disclosure()
    st.stop()

# ---- Compute current values --------------------------------------------
rows = []
hist_map = {}
for h in holdings:
    tk = h["ticker"]
    q = get_quote(tk)
    f = get_stock_fundamentals(tk)
    price = q.get("price") or f.get("price")
    value = (price or 0) * h["shares"]
    cost = h["cost_basis"] * h["shares"]
    rows.append({
        "ticker": tk,
        "shares": h["shares"],
        "price": price,
        "value": value,
        "cost": cost,
        "gain": value - cost,
        "gain_pct": ((value - cost) / cost * 100) if cost else None,
        "sector": f.get("sector") or "Unknown",
    })
    hist_map[tk] = get_history(tk, "1Y")

total_value = sum(r["value"] for r in rows)
total_cost = sum(r["cost"] for r in rows)
total_gain = total_value - total_cost
total_gain_pct = (total_gain / total_cost * 100) if total_cost else None

# ---- Summary metrics ----------------------------------------------------
m1, m2, m3 = st.columns(3)
m1.metric("Current value", human_number(total_value, "$"))
m2.metric("Total cost", human_number(total_cost, "$"))
m3.metric("Total return", human_number(total_gain, "$"),
          delta=f"{total_gain_pct:+.2f}%" if total_gain_pct is not None else None)

# ---- Holdings table -----------------------------------------------------
st.subheader("Holdings")
hdr = ('<div class="sma-row" style="font-weight:700;color:#94a3b8;">'
       '<span style="flex:0 0 70px;">Ticker</span>'
       '<span style="flex:1;">Sector</span>'
       '<span style="flex:0 0 90px;text-align:right;">Price</span>'
       '<span style="flex:0 0 110px;text-align:right;">Value</span>'
       '<span style="flex:0 0 90px;text-align:right;">Return</span></div>')
body = []
for r in sorted(rows, key=lambda x: x["value"], reverse=True):
    body.append(
        f'<div class="sma-row"><span style="flex:0 0 70px;" class="tk">{r["ticker"]}</span>'
        f'<span style="flex:1;">{r["sector"]}</span>'
        f'<span style="flex:0 0 90px;text-align:right;">{fmt_num(r["price"], 2)}</span>'
        f'<span style="flex:0 0 110px;text-align:right;">{human_number(r["value"], "$")}</span>'
        f'<span style="flex:0 0 90px;text-align:right;">{color_pct_html(r["gain_pct"])}</span></div>'
    )
st.markdown(hdr + "".join(body), unsafe_allow_html=True)

# ---- Allocation + sector pies ------------------------------------------
pc1, pc2 = st.columns(2)
with pc1:
    st.subheader("Allocation")
    fig = go.Figure(go.Pie(
        labels=[r["ticker"] for r in rows], values=[r["value"] for r in rows],
        hole=0.45, textinfo="label+percent",
    ))
    fig.update_layout(template="plotly_dark", height=360,
                      margin=dict(l=10, r=10, t=10, b=10), showlegend=False)
    st.plotly_chart(fig, use_container_width=True)

with pc2:
    st.subheader("Sector breakdown")
    sector_val: dict[str, float] = {}
    for r in rows:
        sector_val[r["sector"]] = sector_val.get(r["sector"], 0) + r["value"]
    fig = go.Figure(go.Pie(
        labels=list(sector_val.keys()), values=list(sector_val.values()),
        hole=0.45, textinfo="label+percent",
    ))
    fig.update_layout(template="plotly_dark", height=360,
                      margin=dict(l=10, r=10, t=10, b=10), showlegend=False)
    st.plotly_chart(fig, use_container_width=True)

# ---- Risk ---------------------------------------------------------------
st.subheader("Portfolio risk")
weights = {r["ticker"]: r["value"] for r in rows}
score, label, color, comp = portfolio_risk_score(hist_map, weights)
rg1, rg2 = st.columns([2, 3])
with rg1:
    st.plotly_chart(risk_gauge(score, "Risk score", label), use_container_width=True)
with rg2:
    if comp:
        st.markdown(
            f"- Annualized volatility: **{comp.get('volatility_pct','—')}%**\n"
            f"- Max drawdown (1Y): **{comp.get('max_drawdown_pct','—')}%**\n"
            f"- Largest single position: **{comp.get('largest_position_pct','—')}%**"
        )

# ---- AI deep analysis ---------------------------------------------------
st.subheader("AI portfolio analysis")
if not claude_analyst.is_available():
    st.info("Add your ANTHROPIC_API_KEY to .env to enable AI analysis.")
elif st.button("Generate portfolio analysis"):
    with st.spinner("Asking Claude..."):
        summary = {
            "holdings": [{"ticker": r["ticker"],
                          "weight_pct": round(r["value"] / total_value * 100, 1),
                          "sector": r["sector"],
                          "return_pct": round(r["gain_pct"], 1) if r["gain_pct"] is not None else None}
                         for r in rows],
            "total_value": round(total_value, 2),
            "total_return_pct": round(total_gain_pct, 2) if total_gain_pct is not None else None,
            "risk_score": score,
            "risk_label": label,
            "risk_components": comp,
        }
        try:
            st.markdown(claude_analyst.portfolio_analysis(summary))
        except claude_analyst.AnalystError as e:
            st.error(f"AI analysis failed: {e}")

disclosure()
