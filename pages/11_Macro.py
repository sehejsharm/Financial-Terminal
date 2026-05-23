"""Macro - FRED indicators, yield curve, and an AI macro pulse-check."""
import plotly.graph_objects as go
import streamlit as st

from lib import ai_analyst
from lib.config import get_fred_key
from lib.macro import get_dashboard
from lib.rates import get_yield_curve
from lib.ui import disclosure, fmt_num, setup_page

setup_page("Macro")
st.title("Macro")

if not get_fred_key():
    st.warning(
        "No FRED API key found. Add `FRED_API_KEY` to your .env to load macro "
        "indicators. Get a free key at "
        "https://fredaccount.stlouisfed.org/apikeys."
    )
    disclosure()
    st.stop()

# ---- Indicators ---------------------------------------------------------
st.subheader("Key indicators")
indicators = get_dashboard()
cols = st.columns(4)
for i, ind in enumerate(indicators):
    with cols[i % 4]:
        val = ind.get("value")
        change = ind.get("change")
        st.metric(
            label=ind.get("name", "—"),
            value=f"{val:.2f}{ind.get('unit','')}" if val is not None else "—",
            delta=f"{change:+.2f}{ind.get('unit','')}" if change is not None else None,
        )
        if ind.get("date"):
            st.caption(f"as of {ind['date']}")

# ---- Yield curve --------------------------------------------------------
st.subheader("Treasury yield curve")
curve = get_yield_curve()
if curve.empty:
    st.caption("Yield curve data unavailable.")
else:
    fig = go.Figure(go.Scatter(
        x=curve["maturity"], y=curve["yield"], mode="lines+markers",
        line=dict(color="#ffae00", width=2.5), marker=dict(size=8),
        text=[f"{y:.2f}%" for y in curve["yield"]],
    ))
    fig.update_layout(template="plotly_dark", height=380,
                      paper_bgcolor="#0a0b0d", plot_bgcolor="#0a0b0d",
                      font=dict(family="JetBrains Mono, monospace", color="#cdd1d8"),
                      margin=dict(l=10, r=10, t=10, b=10),
                      xaxis_title="Maturity", yaxis_title="Yield %")
    st.plotly_chart(fig, use_container_width=True)

    spread = None
    try:
        y2 = float(curve.loc[curve["maturity"] == "2Y", "yield"].iloc[0])
        y10 = float(curve.loc[curve["maturity"] == "10Y", "yield"].iloc[0])
        spread = y10 - y2
    except (IndexError, KeyError):
        pass
    if spread is not None:
        shape = "inverted" if spread < 0 else "upward-sloping"
        st.caption(f"10Y-2Y spread: {spread:+.2f}% ({shape} at the 2s10s).")

# ---- AI macro pulse-check ----------------------------------------------
st.subheader("AI macro pulse-check")
if not ai_analyst.is_available():
    st.info("Add GROQ_API_KEY (free at console.groq.com) or GEMINI_API_KEY to your .env to enable the AI pulse-check.")
elif st.button("Generate macro pulse-check"):
    with st.spinner("Asking Gemini..."):
        note = ""
        if not curve.empty:
            note = "; ".join(f"{m}={y:.2f}%" for m, y in
                             zip(curve["maturity"], curve["yield"]))
        try:
            clean = [{k: v for k, v in ind.items() if k in ("name", "value", "unit", "date")}
                     for ind in indicators]
            st.markdown(ai_analyst.macro_pulse_check(clean, note))
        except ai_analyst.AnalystError as e:
            st.error(f"AI analysis failed: {e}")

disclosure()
