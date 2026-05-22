"""Shared Streamlit UI helpers: page setup, formatting, gauges, chips."""
from __future__ import annotations

from datetime import datetime

import plotly.graph_objects as go
import streamlit as st

from lib.config import APP_NAME, DISCLOSURE, SIDEBAR_BRAND

try:
    from streamlit_autorefresh import st_autorefresh
    _HAS_AUTOREFRESH = True
except Exception:  # pragma: no cover - optional dependency
    _HAS_AUTOREFRESH = False

_TONE_COLORS = {
    "positive": "#19d27c",
    "neutral": "#8a8f99",
    "caution": "#ffae00",
}

_CURRENCY_SYMBOLS = {
    "INR": "₹", "USD": "$", "EUR": "€", "GBP": "£",
    "JPY": "¥", "CNY": "¥", "HKD": "HK$", "AUD": "A$",
    "CAD": "C$", "SGD": "S$",
}

# Sleek modern terminal theme: near-black, amber accents, monospace numerals,
# subtle borders and hover glows.
_CSS = """
<style>
  :root { --amber:#ffb000; --bg:#070809; --bg2:#0c0e12; --panel:#0f1218;
          --panel2:#12161d; --line:#1c2129; --line2:#262c36;
          --txt:#dfe3ea; --mut:#767c88; --green:#1fd286; --red:#ff4d4f; }
  html, body, [data-testid="stAppViewContainer"] {
    background:
      radial-gradient(1200px 600px at 80% -10%, rgba(255,176,0,0.05), transparent 60%),
      var(--bg) !important;
  }
  [data-testid="stHeader"] { background:transparent; }
  #MainMenu, footer, [data-testid="stToolbar"] { visibility:hidden; }
  .block-container { padding-top: 1.1rem; max-width: 1560px; }
  section.main, .stMarkdown, p, li, span, label, .stMetric, input, button {
    font-family: "JetBrains Mono","SF Mono","Menlo","Consolas",monospace;
  }
  section.main, .stMarkdown, p, li { font-size: 14.5px; color:var(--txt); }
  h1, h2, h3 { font-family:"JetBrains Mono",monospace !important;
    letter-spacing:0.07em; text-transform:uppercase; font-weight:800; }
  h1 { font-size: 23px !important; color:#fff; margin-bottom:2px;
    background:linear-gradient(90deg,#fff,#cdd1d8); -webkit-background-clip:text; }
  h1::after { content:""; display:block; height:2px; margin-top:8px;
    background:linear-gradient(90deg,var(--amber),transparent 70%); }
  h2, h3 { color:var(--amber) !important; font-size:14px !important;
    border-left:3px solid var(--amber); padding-left:9px; margin-top:6px; }
  [data-testid="stSidebar"] { background:var(--bg); border-right:1px solid var(--line); }
  [data-testid="stMetricValue"] { font-family:"JetBrains Mono",monospace;
    font-size:21px !important; color:#fff; }
  [data-testid="stMetricLabel"] { color:var(--mut) !important;
    text-transform:uppercase; letter-spacing:0.06em; }
  [data-testid="stMetric"] {
    background:linear-gradient(180deg,var(--panel2),var(--panel));
    border:1px solid var(--line); border-radius:6px; padding:10px 14px;
    transition:border-color .15s ease;
  }
  [data-testid="stMetric"]:hover { border-color:var(--line2); }
  .stButton button, [data-baseweb="select"] > div, [data-baseweb="input"] input {
    border-radius:5px !important; }
  .stButton button { background:var(--panel2); border:1px solid var(--line2);
    color:var(--txt); }
  .stButton button:hover { border-color:var(--amber); color:#fff; }
  [data-testid="stSegmentedControl"] button[aria-checked="true"],
  [data-baseweb="segmented-control"] [aria-selected="true"] {
    color:var(--amber) !important; }
  .sma-brand { font-size: 17px; font-weight: 800; letter-spacing:0.22em;
    color:var(--amber); padding: 4px 0 2px 0; }
  .sma-tag { color:var(--mut); font-size:10px; letter-spacing:0.15em;
    text-transform:uppercase; margin-bottom:6px; }
  .sma-status { font-size:11px; color:var(--mut); letter-spacing:0.04em; }
  .sma-status b { color:var(--green); }
  .sma-card {
    background:linear-gradient(180deg,var(--panel2),var(--panel));
    border:1px solid var(--line); border-radius:6px; padding:10px 12px; height:100%;
    transition:border-color .15s ease, box-shadow .15s ease;
  }
  .sma-card:hover { border-color:var(--line2);
    box-shadow:0 0 0 1px rgba(255,176,0,0.08), 0 6px 18px rgba(0,0,0,0.4); }
  .sma-card .nm { color:var(--mut); font-size:10.5px; letter-spacing:0.08em;
    text-transform:uppercase; }
  .sma-card .px { font-size:19px; font-weight:700; color:#fff; }
  .sma-chip {
    display:flex; justify-content:space-between; align-items:center;
    padding:7px 11px; margin:5px 0; border-radius:5px;
    background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--mut);
  }
  .sma-chip .lab { color:var(--mut); font-size:11.5px; letter-spacing:0.05em;
    text-transform:uppercase; }
  .sma-chip .val { font-weight:700; font-size:13.5px; }
  .sma-news {
    padding:11px 13px; margin:7px 0; border-radius:6px; background:var(--panel);
    border:1px solid var(--line); border-left:3px solid var(--amber);
    transition:border-color .15s ease; }
  .sma-news:hover { border-color:var(--line2); }
  .sma-news a { color:#fff; text-decoration:none; font-weight:700; font-size:14.5px; }
  .sma-news .meta { color:var(--amber); font-size:10.5px; margin:4px 0;
    letter-spacing:0.05em; text-transform:uppercase; }
  .sma-news .sum { color:var(--mut); font-size:12.5px; }
  .sma-row {
    display:flex; align-items:center; gap:10px; padding:7px 6px;
    border-bottom:1px solid var(--line); }
  .sma-row:hover { background:rgba(255,255,255,0.02); }
  .sma-row .nm { color:var(--txt); }
  .sma-row .tk { font-weight:700; color:#fff; }
  hr { border-color:var(--line); }
  /* Responsive / mobile */
  @media (max-width: 820px) {
    .block-container { padding-left:0.6rem; padding-right:0.6rem; }
    h1 { font-size:19px !important; }
    h2, h3 { font-size:13px !important; }
    section.main, .stMarkdown, p, li { font-size:13.5px; }
    .sma-card .px { font-size:16px; }
    [data-testid="stMetricValue"] { font-size:17px !important; }
    [data-testid="stHorizontalBlock"] { flex-wrap:wrap; }
  }
</style>
"""


def setup_page(page_title: str, page_icon: str = None) -> None:
    """Page config + styling + mandatory login + branding + live refresh."""
    from lib import auth

    st.set_page_config(page_title=f"{page_title} - {APP_NAME}",
                       page_icon=page_icon, layout="wide")
    st.markdown(_CSS, unsafe_allow_html=True)

    # Mandatory authentication gate - halts the page if not signed in.
    auth.login_gate()

    user = auth.current_user() or {}
    with st.sidebar:
        st.markdown(f'<div class="sma-brand">{SIDEBAR_BRAND}</div>',
                    unsafe_allow_html=True)
        st.markdown('<div class="sma-tag">India + Global · Educational</div>',
                    unsafe_allow_html=True)
        role = "Master Admin" if user.get("role") == "master_admin" else "User"
        st.markdown(
            f'<div class="sma-status">Signed in: <b>{user.get("username","")}</b>'
            f' · {role}</div>', unsafe_allow_html=True)
        if st.button("Sign out", use_container_width=True, key="logout_btn"):
            auth.logout()
            st.rerun()
    realtime_controls()


def realtime_controls() -> None:
    """Sidebar live auto-refresh toggle, interval, manual refresh, timestamp."""
    with st.sidebar:
        st.markdown('<hr>', unsafe_allow_html=True)
        on = st.toggle("Live auto-refresh", value=True, key="rt_on")
        interval = st.select_slider(
            "Refresh every", options=[10, 15, 30, 60, 120], value=30,
            format_func=lambda s: f"{s}s", key="rt_int",
        )
        if st.button("Refresh now", use_container_width=True, key="rt_now"):
            st.cache_data.clear()
            st.rerun()
        if on and _HAS_AUTOREFRESH:
            st_autorefresh(interval=int(interval) * 1000, key="rt_auto")
        dot = "LIVE" if on else "PAUSED"
        st.markdown(
            f'<div class="sma-status">Status <b>{dot}</b> · updated '
            f'{datetime.now().strftime("%H:%M:%S")}</div>',
            unsafe_allow_html=True,
        )


def disclosure() -> None:
    """Render the compliance disclosure footer."""
    st.divider()
    st.caption(DISCLOSURE)


def human_number(n: float | int | None, prefix: str = "") -> str:
    if n is None:
        return "—"
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "—"
    sign = "-" if n < 0 else ""
    n = abs(n)
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= div:
            return f"{sign}{prefix}{n / div:.2f}{suf}"
    return f"{sign}{prefix}{n:,.2f}"


def fmt_pct(v: float | None, digits: int = 2) -> str:
    if v is None:
        return "—"
    return f"{v:+.{digits}f}%"


def fmt_num(v: float | None, digits: int = 2, suffix: str = "") -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):,.{digits}f}{suffix}"
    except (TypeError, ValueError):
        return "—"


def cur_symbol(code: str | None) -> str:
    """Return a currency symbol for a 3-letter code (default empty)."""
    if not code:
        return ""
    return _CURRENCY_SYMBOLS.get(code.upper(), "")


def ticker_picker(label: str = "Search security", default: str = "",
                  key: str = "tp") -> str:
    """Adaptive typeahead: type 2+ letters, pick from live matches.

    Returns the selected symbol, or the raw uppercased query if there are no
    matches (so exact tickers still work).
    """
    from lib.search import search_securities

    q = st.text_input(label, value=default, key=f"{key}_q",
                      placeholder="Type a name or symbol (2+ letters)").strip()
    if len(q) < 2:
        return q.upper()
    results = search_securities(q)
    if not results:
        return q.upper()
    labels = [
        f"{r['symbol']} — {r['name']}"
        + (f"  [{r['exchange']}]" if r["exchange"] else "")
        for r in results
    ]
    choice = st.selectbox("Matches", labels, key=f"{key}_sel",
                          label_visibility="collapsed")
    return results[labels.index(choice)]["symbol"]


def _gauge(value: float, title: str, subtitle: str, steps: list[tuple]) -> go.Figure:
    value = max(0.0, min(100.0, float(value)))
    fig = go.Figure(go.Indicator(
        mode="gauge+number",
        value=value,
        number={"font": {"size": 40, "color": "#e5e7eb"}, "suffix": ""},
        title={"text": f"<b>{title}</b>", "font": {"size": 18, "color": "#e5e7eb"}},
        gauge={
            "axis": {"range": [0, 100], "tickwidth": 1, "tickcolor": "#4b5563"},
            "bar": {"color": "rgba(0,0,0,0)"},  # hide bar; needle shown via threshold
            "borderwidth": 0,
            "steps": [{"range": [a, b], "color": c} for a, b, c in steps],
            "threshold": {
                "line": {"color": "#e5e7eb", "width": 5},
                "thickness": 0.85,
                "value": value,
            },
        },
    ))
    fig.update_layout(
        template="plotly_dark", height=240,
        margin=dict(l=20, r=20, t=50, b=10),
        paper_bgcolor="rgba(0,0,0,0)",
        font=dict(family="JetBrains Mono, Consolas, monospace", color="#cdd1d8"),
    )
    if subtitle:
        fig.add_annotation(text=subtitle, x=0.5, y=-0.05, showarrow=False,
                           font=dict(size=13, color="#94a3b8"))
    return fig


def quality_gauge(value: float, title: str, subtitle: str = "") -> go.Figure:
    """Red (low) to green (high) gauge for quality/strength scores."""
    steps = [(0, 20, "#ef4444"), (20, 40, "#f97316"), (40, 60, "#eab308"),
             (60, 80, "#84cc16"), (80, 100, "#22c55e")]
    return _gauge(value, title, subtitle, steps)


def risk_gauge(value: float, title: str = "Risk score", subtitle: str = "") -> go.Figure:
    """Green (conservative) to red (very aggressive) gauge for risk scores."""
    steps = [(0, 20, "#22c55e"), (20, 40, "#84cc16"), (40, 60, "#eab308"),
             (60, 80, "#f97316"), (80, 100, "#ef4444")]
    return _gauge(value, title, subtitle, steps)


def render_chips(chips: list[dict]) -> None:
    """Render the At-a-glance descriptive chips."""
    html = []
    for c in chips:
        color = _TONE_COLORS.get(c.get("tone", "neutral"), "#9ca3af")
        html.append(
            f'<div class="sma-chip" style="border-left-color:{color};">'
            f'<span class="lab">{c["label"]}</span>'
            f'<span class="val" style="color:{color};">{c["value"]}</span></div>'
        )
    st.markdown("".join(html), unsafe_allow_html=True)


def color_pct_html(v: float | None, digits: int = 2) -> str:
    if v is None:
        return '<span style="color:#9ca3af;">—</span>'
    color = "#19d27c" if v >= 0 else "#ff453a"
    return f'<span style="color:{color};font-weight:700;">{v:+.{digits}f}%</span>'
