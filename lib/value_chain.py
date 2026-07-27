"""Value-chain visualisation — Bloomberg SPLC style.

Calls Gemini for a structured educational overview (suppliers, customers,
competitors) and renders it as an interactive node-network chart similar to
the Bloomberg SPLC function: company centre, suppliers left, customers right,
competitors below, directed edges, dark terminal theme.

Gemini results are cached 12 h per ticker to avoid hammering the free-tier
quota (the main cause of "usage limit reached" errors).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

import plotly.graph_objects as go
import streamlit as st

from lib import ai_analyst

# ── colour palette ────────────────────────────────────────────────────────────
_BG      = "#0c0e12"
_PANEL   = "#0f1218"
_AMBER   = "#ffb000"
_GREEN   = "#1fd286"
_BLUE    = "#60a5fa"
_ORANGE  = "#ff9f43"
_WHITE   = "#ffffff"
_MUT     = "#767c88"
_LINE    = "#1c2129"

# ── Gemini prompt + cache ─────────────────────────────────────────────────────

_JSON_PROMPT = """
You are a financial-data analyst generating an EDUCATIONAL value-chain map
for a Bloomberg-style research terminal.  Return ONLY a single valid JSON
object — no prose, no markdown fences — in exactly this schema:

{{
  "suppliers": [
    {{"name": "Specific named company or product (max 22 chars)",
      "note": "Concrete input supplied + scale if known (max 60 chars)",
      "revenue_pct": <number 0-100: est. share of the SUBJECT's input costs this supplier represents, or null>,
      "pct_cogs": <number 0-100: same as revenue_pct for suppliers — share of the SUBJECT's COGS/input costs, or null>,
      "pct_revenue": <number 0-100: only if this supplier ALSO buys from the subject, else null>,
      "est_usd_value": <number: est. ANNUAL value of this relationship in USD, or null>,
      "yoy_pct": <number: est. YoY change in the SIZE of this relationship, e.g. 12 for +12%, -8 for -8%, or null>,
      "ticker": "<supplier's own primary exchange ticker (e.g. 2222.SR, TSM, RELIANCE.NS) or null>"}},
    ...
  ],
  "customers": [
    {{"name": "Specific named customer or segment (max 22 chars)",
      "note": "What they buy + approx revenue share if known (max 60 chars)",
      "revenue_pct": <number 0-100: est. share of the SUBJECT's revenue from this customer, or null>,
      "pct_revenue": <number 0-100: same as revenue_pct for customers — share of the SUBJECT's revenue, or null>,
      "pct_cogs": <number 0-100: only if this customer ALSO supplies the subject, else null>,
      "est_usd_value": <number: est. ANNUAL value of this relationship in USD, or null>,
      "yoy_pct": <number: est. YoY change in the SIZE of this relationship, or null>,
      "ticker": "<customer's own primary exchange ticker or null>"}},
    ...
  ],
  "competitors": [
    {{"name": "Named competitor company (max 22 chars)",
      "note": "Which segment they compete in + relative position (max 60 chars)",
      "revenue_pct": null,
      "est_usd_value": null,
      "yoy_pct": null,
      "ticker": "<competitor's own primary exchange ticker or null>"}},
    ...
  ]
}}

Hard rules (the model that ignores these will be rejected):
- **NAME REAL COMPANIES**, not categories. Use "Lufthansa", "IndiGo", "Boeing 737 MAX engines" — NEVER "jet companies", "airlines", "OEMs", "various retailers".
- If a customer is a segment rather than a single company (e.g. "US gas stations"), name 1–2 marquee examples in the note ("incl. 7-Eleven, Costco").
- If the company has reporting segments (e.g. for Reliance: Oil-to-Chemicals, Jio, Retail), MAP EACH SEGMENT separately — Jio's customers, Retail's customers, O2C's customers. Tag the segment in the note.
- Notes should include hard specifics where you know them: feedstock type, contract value bands, % of revenue, geography.
- **EXHAUSTIVE COVERAGE — aim for 10 suppliers, 12 customers, 8 competitors.** Do not stop at 3-5. If the company has many marquee customers, list them all up to the cap.
- Spread across geographies and business lines — don't list 8 customers all from one segment.
- Mark uncertainty inline ("est.", "pre-2023", "publicly disclosed") rather than padding with vague entries.
- Names must fit in chart nodes (≤22 chars). If a real name is too long, abbreviate (e.g. "Saudi Aramco").
- "revenue_pct" is an ESTIMATE — a plain number, no % sign. null when you have no basis. Never invent precision.
- QUANTITATIVE FIELDS ARE OPT-IN, NOT MANDATORY. "pct_revenue", "pct_cogs",
  "est_usd_value" and "yoy_pct" must be null unless you have a CONCRETE basis
  (a disclosed contract value, a segment breakdown, a reported customer
  concentration). Returning one field and nulling the rest is CORRECT and
  expected — a fabricated dollar figure or growth rate is far worse than null,
  because the UI renders these as relationship weights users compare.
- "est_usd_value" is a plain number of US dollars (e.g. 2400000000 for $2.4bn),
  no currency symbol, no units suffix.
- "ticker" must be the partner's OWN primary listing, exact symbol with exchange suffix for non-US listings. Do NOT guess: a subsidiary's or similarly-named company's ticker is WORSE than null (e.g. Saudi Aramco is 2222.SR — 2223.SR is its Luberef subsidiary, wrong). Private/state entities and segments: null.
- The subject company is: {name} ({ticker}){grounding}
- GROUNDING RULE: map the company NAMED ABOVE with the sector/industry given.
  If your knowledge of this ticker conflicts with the name/sector above, the
  name/sector above wins — do NOT map a different company that shares the
  ticker letters.
"""


def _parse_chain_json(raw: str) -> dict | None:
    raw = re.sub(r"```[a-z]*", "", raw).strip().strip("`").strip()
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group())
    except json.JSONDecodeError:
        return None


@st.cache_data(ttl=43200, show_spinner=False)   # 12-hour cache per ticker
def get_chain_data(ticker: str, company_name: str, sector: str | None = None,
                   industry: str | None = None, nonce: int = 0) -> dict | None:
    """Structured value-chain JSON, grounded in the RESOLVED company's
    verified sector/industry. `nonce` busts the cache for user-requested
    regeneration. One stricter retry on parse failure."""
    grounding = ""
    if sector or industry:
        grounding = (f"\n- VERIFIED DATA: sector = {sector or 'n/a'}, "
                     f"industry = {industry or 'n/a'}.")
    prompt = _JSON_PROMPT.format(name=company_name, ticker=ticker,
                                 grounding=grounding)
    data = None
    for attempt in range(2):
        try:
            raw = ai_analyst._call(prompt, max_tokens=2200)
        except ai_analyst.AnalystError:
            raise
        data = _parse_chain_json(raw)
        if data is not None:
            break
        # Stricter re-prompt: parse failures are usually prose leakage.
        prompt = (prompt + "\n\nIMPORTANT: your previous answer was not valid "
                  "JSON. Return ONLY the JSON object — no prose, no fences.")
    if data is None:
        return None
    # Provenance: this is generated content, not filing-sourced data. Stamped
    # inside the cached payload so the timestamp reflects actual generation
    # time, not cache-serve time.
    data["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["source"] = ai_analyst.active_provider()
    return data


# ── chart builder ─────────────────────────────────────────────────────────────

def _trunc(s: str, n: int = 20) -> str:
    return s if len(s) <= n else s[:n - 1] + "…"


def _rgba(hex_color: str, alpha: float) -> str:
    """Convert '#rrggbb' to an 'rgba(r,g,b,a)' string Plotly accepts."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha})"


def build_chain_figure(ticker: str, company_name: str, data: dict) -> go.Figure:
    """Return a Plotly figure in Bloomberg SPLC node-graph style."""
    suppliers   = (data.get("suppliers")   or [])[:7]
    customers   = (data.get("customers")   or [])[:7]
    competitors = (data.get("competitors") or [])[:6]

    node_x, node_y = [], []
    node_label, node_hover = [], []
    node_color, node_size, node_textpos = [], [], []

    edge_x, edge_y = [], []
    arrow_x, arrow_y, arrow_ex, arrow_ey, arrow_color = [], [], [], [], []

    # ── centre: company ───────────────────────────────────────────────────────
    cx, cy = 0.0, 0.0
    node_x.append(cx);  node_y.append(cy)
    node_label.append(_trunc(ticker, 12))
    node_hover.append(f"<b>{company_name}</b>")
    node_color.append(_AMBER)
    node_size.append(38)
    node_textpos.append("middle center")

    def _add_node(x, y, label, hover, color, size, tpos):
        node_x.append(x);  node_y.append(y)
        node_label.append(label)
        node_hover.append(hover)
        node_color.append(color)
        node_size.append(size)
        node_textpos.append(tpos)

    def _add_edge(x0, y0, x1, y1, col):
        edge_x.extend([x0, x1, None])
        edge_y.extend([y0, y1, None])
        arrow_x.append(x0);   arrow_y.append(y0)
        arrow_ex.append(x1);  arrow_ey.append(y1)
        arrow_color.append(col)

    X_SUP  = -2.6
    X_CUST =  2.6
    Y_COMP = -2.4

    # ── suppliers (left column → centre) ─────────────────────────────────────
    ns = len(suppliers)
    for i, s in enumerate(suppliers):
        y = (i - (ns - 1) / 2) * 1.05
        lbl = _trunc(s.get("name", ""), 20)
        hov = f"<b>{s.get('name','')}</b><br>{s.get('note','')}"
        _add_node(X_SUP, y, lbl, hov, _GREEN, 18, "middle left")
        _add_edge(X_SUP, y, cx, cy, _GREEN)

    # ── customers (centre → right column) ────────────────────────────────────
    nc = len(customers)
    for i, c in enumerate(customers):
        y = (i - (nc - 1) / 2) * 1.05
        lbl = _trunc(c.get("name", ""), 20)
        hov = f"<b>{c.get('name','')}</b><br>{c.get('note','')}"
        _add_node(X_CUST, y, lbl, hov, _BLUE, 18, "middle right")
        _add_edge(cx, cy, X_CUST, y, _BLUE)

    # ── competitors (bottom row, no edge to centre per Bloomberg) ─────────────
    ncp = len(competitors)
    for i, cp in enumerate(competitors):
        x = (i - (ncp - 1) / 2) * 1.35
        lbl = _trunc(cp.get("name", ""), 20)
        hov = f"<b>{cp.get('name','')}</b><br>{cp.get('note','')}"
        _add_node(x, Y_COMP, lbl, hov, _ORANGE, 15, "bottom center")

    # ── figure ────────────────────────────────────────────────────────────────
    fig = go.Figure()

    # Edges
    fig.add_trace(go.Scatter(
        x=edge_x, y=edge_y, mode="lines",
        line=dict(color="rgba(255,255,255,0.10)", width=1.5),
        hoverinfo="skip", showlegend=False,
    ))

    # Directed arrows (annotation arrows for each edge)
    annotations = []
    for ax, ay, aex, aey, acol in zip(arrow_x, arrow_y, arrow_ex, arrow_ey, arrow_color):
        # midpoint of line for arrowhead
        mx = (ax + aex) / 2
        my = (ay + aey) / 2
        annotations.append(dict(
            x=aex, y=aey, ax=ax, ay=ay,
            xref="x", yref="y", axref="x", ayref="y",
            showarrow=True, arrowhead=2, arrowsize=1.2, arrowwidth=1.2,
            arrowcolor=_rgba(acol, 0.53),  # semi-transparent
        ))

    # Nodes
    fig.add_trace(go.Scatter(
        x=node_x, y=node_y,
        mode="markers+text",
        marker=dict(
            color=node_color,
            size=node_size,
            line=dict(color="rgba(255,255,255,0.18)", width=1.5),
            symbol="circle",
        ),
        text=node_label,
        textfont=dict(family="JetBrains Mono, Consolas, monospace",
                      size=[10 if s < 30 else 12 for s in node_size],
                      color=["#000" if c == _AMBER else _WHITE for c in node_color]),
        textposition=node_textpos,
        hovertext=node_hover,
        hoverinfo="text",
        showlegend=False,
    ))

    # Section header annotations
    y_sup_top  = ((ns  - 1) / 2) * 1.05 + 0.6 if ns  else 0.8
    y_cust_top = ((nc  - 1) / 2) * 1.05 + 0.6 if nc  else 0.8
    for ann_x, ann_y, label, col in (
        (X_SUP,  y_sup_top,  "▶  SUPPLIERS",   _GREEN),
        (X_CUST, y_cust_top, "CUSTOMERS  ◀",   _BLUE),
        (0,      Y_COMP - 0.5, "COMPETITORS",  _ORANGE),
    ):
        annotations.append(dict(
            x=ann_x, y=ann_y, xref="x", yref="y",
            text=f'<b style="letter-spacing:0.06em">{label}</b>',
            showarrow=False,
            font=dict(color=col, size=11, family="JetBrains Mono, monospace"),
            align="center",
        ))

    # Central company label (below node)
    annotations.append(dict(
        x=cx, y=cy - 0.55, xref="x", yref="y",
        text=f'<b>{_trunc(company_name, 28)}</b>',
        showarrow=False,
        font=dict(color=_AMBER, size=10, family="JetBrains Mono, monospace"),
        align="center",
    ))

    x_pad = 4.2
    y_max = max(y_sup_top, y_cust_top) + 0.4
    y_min = Y_COMP - 1.0

    fig.update_layout(
        annotations=annotations,
        paper_bgcolor=_PANEL,
        plot_bgcolor=_PANEL,
        showlegend=False,
        xaxis=dict(visible=False, range=[-x_pad, x_pad], zeroline=False, fixedrange=True),
        yaxis=dict(visible=False, range=[y_min, y_max], zeroline=False,
                   scaleanchor="x", scaleratio=1, fixedrange=True),
        height=560,
        margin=dict(l=0, r=0, t=20, b=10),
        font=dict(family="JetBrains Mono, Consolas, monospace", color="#dfe3ea", size=11),
        hoverlabel=dict(bgcolor=_BG, bordercolor=_LINE,
                        font=dict(family="JetBrains Mono", size=12, color=_WHITE)),
        dragmode=False,
    )
    return fig
