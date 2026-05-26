"""Screeners — preset and custom screens, plus value-investing scans.

Includes the old Value Investing screens (Buffett / Graham) folded in as
additional tabs.  Result tables expose an 'Open in Terminal' jump so you can
dive into any name in one click.
"""
from __future__ import annotations

import pandas as pd
import streamlit as st

from lib.screens import (
    FILTER_METRICS,
    PRESETS,
    apply_filters,
    buffett_screen,
    etf_screen,
    graham_screen,
    run_preset,
    scan_universe,
)
from lib.ui import disclosure, setup_page

setup_page("Screeners")
st.title("Screeners")
st.caption(
    "Find names that match an investment style. Click any ticker in a "
    "result table, then press **Open in Terminal** to dig in."
)
st.warning(
    "Best-effort screens on free data. Multi-year growth, true promoter "
    "holding, industry P/E and clean ROCE are not in the free feed — these "
    "use trailing-growth proxies. Use as a research starting point."
)

# ── helper: render results + 'Open in Terminal' jump ─────────────────────────
def _open_in_terminal(ticker: str, suffix: str = ""):
    """Render an 'Open in Terminal' button that navigates with this ticker."""
    if st.button(f"Open **{ticker}** in Terminal →", key=f"open_{ticker}_{suffix}",
                 use_container_width=True):
        st.session_state["nav_ticker"] = ticker
        st.switch_page("pages/3_Terminal.py")


def _results_block(rows: list[dict], display_cols: dict, suffix: str,
                   ticker_field: str = "ticker"):
    """Render a result dataframe + per-row ticker jump-list."""
    if not rows:
        st.info("No matches in the scanned universe.")
        return
    df = pd.DataFrame(rows)
    keep = [c for c in display_cols if c in df.columns]
    df_disp = df[keep].rename(columns=display_cols)
    st.success(f"{len(rows)} matches.")
    st.dataframe(df_disp, use_container_width=True, hide_index=True)

    # Quick-jump: pick any of the matching tickers and open it in Terminal.
    tickers = [row[ticker_field] for row in rows if row.get(ticker_field)]
    if tickers:
        jc1, jc2 = st.columns([3, 2])
        with jc1:
            pick = st.selectbox("Jump to ticker", tickers, key=f"jump_{suffix}")
        with jc2:
            st.write("")  # vertical alignment
            # The Indian screen tickers come back with the .NS stripped; restore.
            full = pick if pick.endswith(".NS") or "." in pick else f"{pick}.NS"
            _open_in_terminal(full, suffix=suffix)


# ── tabs ─────────────────────────────────────────────────────────────────────
tabs = st.tabs([
    "PEG", "Hidden Gems", "Growth",
    "Buffett Quality", "Graham Value", "Top ETFs",
    "Custom",
])

PRESET_COLS = {
    "ticker": "Ticker", "name": "Name", "mcap_cr": "Mkt cap (cr)",
    "eps_growth": "EPS gr%", "sales_growth": "Sales gr%", "peg": "PEG",
    "de": "D/E", "roce": "ROCE/ROE%", "promoter": "Promoter%", "pe": "P/E",
}

# ---- 1. PEG ---------------------------------------------------------------
with tabs[0]:
    st.caption(PRESETS["PEG Screen"]["desc"])
    if st.button("Run PEG screen", key="run_peg"):
        with st.spinner("Scanning universe (first run can take a minute)..."):
            rows = scan_universe()
            _results_block(run_preset("PEG Screen", rows), PRESET_COLS, "peg")

# ---- 2. Hidden Gems --------------------------------------------------------
with tabs[1]:
    st.caption(PRESETS["Hidden Gems"]["desc"])
    if st.button("Run Hidden Gems screen", key="run_gems"):
        with st.spinner("Scanning universe..."):
            rows = scan_universe()
            _results_block(run_preset("Hidden Gems", rows), PRESET_COLS, "gems")

# ---- 3. Growth ------------------------------------------------------------
with tabs[2]:
    st.caption(PRESETS["Growth"]["desc"])
    if st.button("Run Growth screen", key="run_growth"):
        with st.spinner("Scanning universe..."):
            rows = scan_universe()
            _results_block(run_preset("Growth", rows), PRESET_COLS, "growth")

# ---- 4. Buffett Quality ---------------------------------------------------
with tabs[3]:
    st.caption(
        "Names scoring ≥ threshold on a Buffett-style quality checklist "
        "(margins, ROE, D/E, FCF, valuation). Educational scorecard."
    )
    min_score = st.slider("Minimum quality score (0–100)", 50, 100, 70,
                          key="bf_min")
    if st.button("Run Buffett Quality screen", key="run_buf"):
        with st.spinner("Scoring universe against Buffett tenets..."):
            rows = buffett_screen(min_score)
            _results_block(rows, {
                "ticker": "Ticker", "name": "Name", "mcap_cr": "Mkt cap (cr)",
                "score": "Score", "passes": "Pass", "warns": "Warn", "fails": "Fail",
                "roe": "ROE %", "pe": "P/E", "peg": "PEG", "de": "D/E",
            }, "buf")

# ---- 5. Graham Value ------------------------------------------------------
with tabs[4]:
    st.caption(
        "Names trading below Graham intrinsic value by your minimum margin "
        "of safety. V = EPS × (8.5 + 2g) × 4.4 / Y."
    )
    g1, g2, g3 = st.columns(3)
    g_growth = g1.number_input("Default growth % (when missing)", value=8.0,
                               step=1.0, key="gv_g")
    g_yield  = g2.number_input("High-grade bond yield %", value=7.0,
                               step=0.25, key="gv_y")
    g_mos    = g3.number_input("Min margin of safety %", value=20.0,
                               step=5.0, key="gv_m")
    if st.button("Run Graham Value screen", key="run_gv"):
        with st.spinner("Computing intrinsic value for universe..."):
            rows = graham_screen(g_growth, g_yield, g_mos)
            _results_block(rows, {
                "ticker": "Ticker", "name": "Name", "price": "Price",
                "intrinsic": "Graham IV", "margin_of_safety": "MoS %",
                "eps": "EPS (TTM)", "growth_used": "Growth %", "pe": "P/E",
            }, "gv")

# ---- 6. Top ETFs ----------------------------------------------------------
with tabs[5]:
    st.caption(
        "Rank a curated ETF universe (India + US) by performance, cost, "
        "or assets. Educational; not all funds are equivalent."
    )
    e1, e2 = st.columns([2, 3])
    sort_by = e1.selectbox(
        "Rank by",
        ["ytd_return", "three_year_return", "five_year_return",
         "expense_ratio_asc", "total_assets"],
        format_func=lambda k: {
            "ytd_return": "YTD return",
            "three_year_return": "3-yr return (ann.)",
            "five_year_return": "5-yr return (ann.)",
            "expense_ratio_asc": "Cheapest first (expense ratio)",
            "total_assets": "Largest first (AUM)",
        }[k],
        key="etf_sort")
    sector = e2.text_input(
        "Filter by category contains (optional)", value="",
        placeholder="e.g. Technology, India, Equity", key="etf_sec",
    ).strip() or None
    if st.button("Run Top ETFs screen", key="run_etf"):
        with st.spinner("Fetching ETF metrics..."):
            rows = etf_screen(sort_by, sector)
            # ETFs use the raw ticker (no .NS stripping done in etf_screen).
            _results_block(rows, {
                "ticker": "Ticker", "name": "Name", "category": "Category",
                "ytd_return": "YTD %", "three_year_return": "3-yr %",
                "five_year_return": "5-yr %", "expense_ratio": "ER %",
                "total_assets": "AUM", "beta_3y": "Beta 3y",
            }, "etfs")

# ---- 7. Custom ------------------------------------------------------------
with tabs[6]:
    st.caption("Add filters; results must satisfy all of them (AND).")
    labels = ["—"] + [m[0] for m in FILTER_METRICS]
    key_by_label = {m[0]: m[1] for m in FILTER_METRICS}
    filters = []
    for i in range(4):
        cc1, cc2, cc3 = st.columns([3, 1, 2])
        lab = cc1.selectbox(f"Metric {i+1}", labels, key=f"flt_m_{i}")
        op  = cc2.selectbox("Op", [">", "<"], key=f"flt_o_{i}")
        val = cc3.number_input("Value", value=0.0, step=1.0, key=f"flt_v_{i}")
        if lab != "—":
            filters.append({"key": key_by_label[lab], "op": op, "value": val})
    if st.button("Run custom screen", key="run_custom"):
        if not filters:
            st.info("Add at least one filter.")
        else:
            with st.spinner("Scanning universe..."):
                rows = scan_universe()
                _results_block(apply_filters(rows, filters), PRESET_COLS,
                               "custom")

disclosure()
