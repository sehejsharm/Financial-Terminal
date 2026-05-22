"""Value Investing - Oracle Checklist (Buffett) and Graham valuation engine."""
import streamlit as st

from lib.market_data import get_quote, get_stock_fundamentals
from lib.ui import (
    cur_symbol,
    disclosure,
    fmt_num,
    quality_gauge,
    setup_page,
    ticker_picker,
)
from lib.value_investing import (
    buffett_checklist,
    graham_intrinsic_value,
    margin_of_safety,
)

setup_page("Value Investing")
st.title("Value Investing")

c1, c2 = st.columns([2, 2])
with c1:
    ticker = ticker_picker("Search security", default="RELIANCE.NS", key="vi_pick")
if not ticker:
    st.stop()

f = get_stock_fundamentals(ticker)
quote = get_quote(ticker)
price = f.get("price") or quote.get("price")
cur = cur_symbol(f.get("currency") or quote.get("currency"))
st.markdown(f"### {f.get('name', ticker)}  \n**{ticker}**")

_STATUS = {
    "pass": ("PASS", "#1fd286"), "warn": ("WARN", "#ffb000"),
    "fail": ("FAIL", "#ff4d4f"), "na": ("N/A", "#767c88"),
}

# ---- Graham valuation engine -------------------------------------------
st.subheader("Graham Valuation Engine")
g1, g2, g3 = st.columns(3)
eps = g1.number_input("EPS (trailing)", value=float(f.get("eps_trailing") or 0.0),
                      step=0.5, format="%.2f")
default_growth = (f.get("earnings_growth") or f.get("revenue_growth") or 0.0) * 100
growth = g2.number_input("Expected growth % (annual)",
                         value=round(float(default_growth), 1), step=1.0)
bond_yield = g3.number_input("High-grade bond yield %", value=7.0, step=0.25,
                             help="India 10Y G-sec is a common proxy (~7%).")

intrinsic = graham_intrinsic_value(eps, growth, bond_yield)
mos = margin_of_safety(intrinsic, price)

mv1, mv2, mv3 = st.columns(3)
mv1.metric("Live price", f"{cur}{fmt_num(price, 2)}")
mv2.metric("Graham intrinsic value",
           f"{cur}{fmt_num(intrinsic, 2)}" if intrinsic else "—")
mv3.metric("Margin of safety", f"{mos:+.1f}%" if mos is not None else "—",
           delta="Undervalued" if (mos or 0) > 0 else "Overvalued"
           if mos is not None else None)
if intrinsic and price:
    if mos is not None and mos >= 20:
        st.success("Trades below Graham intrinsic value with a margin of safety "
                   "(educational signal, not advice).")
    elif mos is not None and mos < 0:
        st.warning("Trades above the Graham intrinsic estimate (no margin of "
                   "safety on these inputs).")
st.caption("Graham's formula is a rough rule of thumb; results are highly "
           "sensitive to the growth and yield inputs above. Educational only.")

# ---- Oracle Checklist (Buffett) ----------------------------------------
st.subheader("The Oracle Checklist (Buffett tenets)")
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
    st.caption("A scorecard of classic quality/value tenets — descriptive, "
               "not a recommendation.")

categories = ["Business", "Management", "Financial", "Value"]
cols = st.columns(2)
for idx, cat in enumerate(categories):
    with cols[idx % 2]:
        st.markdown(f"**{cat}**")
        for it in [i for i in items if i["category"] == cat]:
            label, color = _STATUS[it["status"]]
            st.markdown(
                f'<div class="sma-chip" style="border-left-color:{color};">'
                f'<span class="lab">{it["criterion"]}</span>'
                f'<span class="val" style="color:{color};">{label}</span></div>'
                f'<div style="font-size:11px;color:#767c88;margin:-2px 0 6px 2px;">'
                f'{it["detail"]}</div>',
                unsafe_allow_html=True,
            )

disclosure()
