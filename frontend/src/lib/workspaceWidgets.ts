/** Widget catalogue for the workspace.
 *
 *  Metadata only — no JSX — so the layout logic and its tests can reason
 *  about which widgets exist, which need a ticker, and how tall they want to
 *  be, without pulling React in. The renderer maps id -> component.
 */

export type WidgetCategory = "price" | "fundamentals" | "risk" | "flow" | "research";

export type WidgetDef = {
  id: string;
  label: string;
  category: WidgetCategory;
  /** Does this widget care about a ticker? Drives the pane's ticker box and
   *  whether a link group means anything for it. */
  needsTicker: boolean;
  /** One line for the picker. */
  blurb: string;
  /** Suggested minimum pane height in px — a chart in a 120px pane is
   *  useless, a snapshot is fine. */
  minHeight: number;
};

const W = (
  id: string, label: string, category: WidgetCategory, needsTicker: boolean,
  blurb: string, minHeight = 240,
): WidgetDef => ({ id, label, category, needsTicker, blurb, minHeight });

export const WIDGETS: WidgetDef[] = [
  // ── price & technicals ──
  W("chart", "Price chart", "price", true, "Candles with indicators and a live last bar.", 320),
  W("snapshot", "Snapshot", "price", true, "Price, market cap, P/E, beta, ROE, yield.", 180),
  W("quotebar", "Quote strip", "price", true, "Live price, change, day range and volume.", 130),
  W("volcone", "Volatility cone", "risk", true, "Realized vol vs its own history at every horizon.", 380),
  W("backtest", "Backtest", "risk", true, "Run a rule over history — equity curve and stats.", 420),

  // ── fundamentals ──
  W("financials", "Financials", "fundamentals", true, "Income statement, balance sheet, cash flow.", 320),
  W("estimates", "Estimates", "fundamentals", true, "Street forecasts and price targets.", 260),
  W("ratings", "Street ratings", "fundamentals", true, "Analyst recommendations and target spread.", 240),
  W("comparables", "Comparables", "fundamentals", true, "Peer multiples side by side.", 280),
  W("earnings", "Earnings history", "fundamentals", true, "Reported vs expected, surprise history.", 240),
  W("wacc", "WACC model", "fundamentals", true, "Cost of capital with editable assumptions.", 320),
  W("capstruct", "Capital structure", "fundamentals", true, "Debt, cash and equity mix.", 260),
  W("debt", "Debt profile", "fundamentals", true, "Leverage, coverage and maturity picture.", 240),

  // ── flow & ownership ──
  W("ownership", "Ownership", "flow", true, "Institutional and insider holdings.", 260),
  W("options", "Options chain", "flow", true, "Strikes, Greeks and open interest.", 320),
  W("optbuilder", "Option strategy", "flow", true, "Build a structure and see its payoff.", 420),
  W("movers", "Movers", "flow", false, "Top gainers and losers, live.", 240),
  W("watchlist", "Watchlists", "flow", false, "Your lists, streaming.", 280),

  // ── research ──
  W("news", "News", "research", true, "Headlines for this name.", 280),
  W("valuechain", "Value chain", "research", true, "Suppliers, customers and competitors.", 420),
  W("contagion", "Contagion path", "research", true, "Shortest route between any two companies.", 200),
  W("ai", "AI analysis", "research", true, "Bull/bear case and deep-dive.", 320),
  W("notes", "Notes", "research", true, "Your own notes on this name.", 240),
];

export const WIDGET_IDS = new Set(WIDGETS.map((w) => w.id));

const BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));

export function widget(id: string): WidgetDef | undefined {
  return BY_ID.get(id);
}

export function widgetLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function needsTicker(id: string): boolean {
  return BY_ID.get(id)?.needsTicker ?? false;
}

export const CATEGORY_LABELS: Record<WidgetCategory, string> = {
  price: "Price & technicals",
  fundamentals: "Fundamentals",
  risk: "Risk & quant",
  flow: "Flow & ownership",
  research: "Research",
};

export function widgetsByCategory(): [WidgetCategory, WidgetDef[]][] {
  const order: WidgetCategory[] = ["price", "fundamentals", "risk", "flow", "research"];
  return order.map((c) => [c, WIDGETS.filter((w) => w.category === c)]);
}

// ── desk presets ──────────────────────────────────────────────────────────
// Ready-made arrangements. Each is a grid of widget ids with the link group
// each pane binds to, so a preset arrives already wired for one-keystroke
// retargeting.

export type DeskPreset = {
  id: string;
  name: string;
  blurb: string;
  /** rows -> panes -> [widgetId, linkGroup] */
  rows: [string, string][][];
};

export const DESK_PRESETS: DeskPreset[] = [
  {
    id: "research",
    name: "Research desk",
    blurb: "Chart and news up top, fundamentals and value chain below — all one symbol.",
    rows: [
      [["chart", "A"], ["news", "A"]],
      [["financials", "A"], ["valuechain", "A"]],
    ],
  },
  {
    id: "monitor",
    name: "Market monitor",
    blurb: "Movers, watchlists and a chart — the what's-happening-now board.",
    rows: [
      [["movers", "none"], ["watchlist", "none"]],
      [["chart", "A"], ["quotebar", "A"], ["news", "A"]],
    ],
  },
  {
    id: "compare",
    name: "Head to head",
    blurb: "Two symbols on independent link groups, charted and valued side by side.",
    rows: [
      [["chart", "A"], ["chart", "B"]],
      [["snapshot", "A"], ["snapshot", "B"], ["comparables", "A"]],
    ],
  },
  {
    id: "risk",
    name: "Risk desk",
    blurb: "Volatility, options and the option builder for one underlying.",
    rows: [
      [["volcone", "A"], ["options", "A"]],
      [["optbuilder", "A"]],
    ],
  },
  {
    id: "quant",
    name: "Quant bench",
    blurb: "Backtest a rule against the chart and its vol regime.",
    rows: [
      [["backtest", "A"]],
      [["chart", "A"], ["volcone", "A"]],
    ],
  },
  {
    id: "valuation",
    name: "Valuation",
    blurb: "WACC, estimates, comparables and the street's view together.",
    rows: [
      [["wacc", "A"], ["estimates", "A"]],
      [["comparables", "A"], ["ratings", "A"]],
    ],
  },
];

export function preset(id: string): DeskPreset | undefined {
  return DESK_PRESETS.find((p) => p.id === id);
}
