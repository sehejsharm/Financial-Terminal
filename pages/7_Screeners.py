"""Screeners - preset fundamental screens and a custom filter builder."""
import pandas as pd
import streamlit as st

from lib.screens import (
    FILTER_METRICS,
    PRESETS,
    apply_filters,
    run_preset,
    scan_universe,
)
from lib.ui import disclosure, setup_page

setup_page("Screeners")
st.title("Screeners")
st.warning(
    "Best-effort screens on free data. Multi-year (5y/7y) growth, true promoter "
    "holding, industry P/E and clean ROCE are not in the free feed — these use "
    "trailing-growth proxies, insider holding for promoter, ROCE-or-ROE, and "
    "omit the industry-P/E rule. Use as a research starting point, not gospel."
)

COLUMNS = {
    "ticker": "Ticker", "name": "Name", "mcap_cr": "Mkt cap (cr)",
    "eps_growth": "EPS gr%", "sales_growth": "Sales gr%", "peg": "PEG",
    "de": "D/E", "roce": "ROCE/ROE%", "promoter": "Promoter%", "pe": "P/E",
}


def results_table(rows):
    if not rows:
        st.info("No matches in the scanned universe.")
        return
    df = pd.DataFrame(rows)[list(COLUMNS.keys())].rename(columns=COLUMNS)
    st.success(f"{len(rows)} matches.")
    st.dataframe(df, use_container_width=True, hide_index=True)


tabs = st.tabs(["PEG Screen", "Hidden Gems", "Growth", "Custom (Motherboard Screener)"])

for tab, name in zip(tabs[:3], ["PEG Screen", "Hidden Gems", "Growth"]):
    with tab:
        st.caption(PRESETS[name]["desc"])
        if st.button(f"Run {name}", key=f"run_{name}"):
            with st.spinner("Scanning universe (first run can take a minute)..."):
                rows = scan_universe()
                results_table(run_preset(name, rows))

with tabs[3]:
    st.caption("Add filters; results must satisfy all of them (AND).")
    if "scr_n" not in st.session_state:
        st.session_state.scr_n = 3
    labels = ["—"] + [m[0] for m in FILTER_METRICS]
    key_by_label = {m[0]: m[1] for m in FILTER_METRICS}
    filters = []
    for i in range(4):
        c1, c2, c3 = st.columns([3, 1, 2])
        lab = c1.selectbox(f"Metric {i+1}", labels, key=f"flt_m_{i}")
        op = c2.selectbox("Op", [">", "<"], key=f"flt_o_{i}")
        val = c3.number_input("Value", value=0.0, step=1.0, key=f"flt_v_{i}")
        if lab != "—":
            filters.append({"key": key_by_label[lab], "op": op, "value": val})
    if st.button("Run custom screen", key="run_custom"):
        if not filters:
            st.info("Add at least one filter.")
        else:
            with st.spinner("Scanning universe..."):
                rows = scan_universe()
                results_table(apply_filters(rows, filters))

disclosure()
