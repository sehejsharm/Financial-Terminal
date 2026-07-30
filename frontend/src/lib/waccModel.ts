/** The cost of capital, and whether the business clears it.
 *
 *  The WACC screen computed one number from seven inputs and printed it. Three
 *  things were wrong with that.
 *
 *  First, a single point estimate hides how little it is worth: move the equity
 *  risk premium by a percentage point — an assumption nobody can observe — and
 *  the WACC moves enough to change a valuation by a fifth. A grid shows that
 *  where a number cannot.
 *
 *  Second, the risk-free rate defaulted to 7% for every listing on earth. That
 *  is roughly India; it is nowhere near the US or the euro area, and a reader
 *  who doesn't notice gets a discount rate that is wrong by 300bp before they
 *  start.
 *
 *  Third, and most important: a cost of capital in isolation answers nothing.
 *  The question is whether the company earns more on its capital than the
 *  capital costs. That spread is the whole of value creation, and it was
 *  nowhere on the screen.
 *
 *  All pure. The point of putting the arithmetic here is that the thresholds
 *  and the refusals are testable.
 */

export type Region = {
  key: string;
  label: string;
  /** Long-bond yield, in percent. */
  rf: number;
  /** Equity risk premium, in percent. */
  erp: number;
  /** Statutory corporate rate, in percent. */
  tax: number;
  /** Typical investment-grade pre-tax cost of debt, in percent. */
  rd: number;
};

/**
 * Regional defaults. Deliberately round numbers, because a rate quoted to two
 * decimals implies it was looked up today and it wasn't — these are anchors
 * the user is expected to overwrite, and the UI says so.
 */
export const REGIONS: Region[] = [
  { key: "IN", label: "India", rf: 7.0, erp: 6.5, tax: 25.2, rd: 8.5 },
  { key: "US", label: "United States", rf: 4.3, erp: 5.0, tax: 21.0, rd: 5.5 },
  { key: "GB", label: "United Kingdom", rf: 4.5, erp: 5.5, tax: 25.0, rd: 6.0 },
  { key: "EU", label: "Euro area", rf: 2.6, erp: 5.5, tax: 25.0, rd: 4.5 },
  { key: "JP", label: "Japan", rf: 1.6, erp: 5.5, tax: 30.6, rd: 2.5 },
  { key: "HK", label: "Hong Kong / China", rf: 3.2, erp: 6.5, tax: 25.0, rd: 5.0 },
];

const SUFFIX_REGION: Record<string, string> = {
  NS: "IN", BO: "IN",
  L: "GB",
  DE: "EU", PA: "EU", AS: "EU", MI: "EU", MC: "EU", BR: "EU", VI: "EU", HE: "EU",
  T: "JP",
  HK: "HK", SS: "HK", SZ: "HK",
};

const CURRENCY_REGION: Record<string, string> = {
  INR: "IN", USD: "US", GBP: "GB", GBp: "GB", EUR: "EU", JPY: "JP",
  HKD: "HK", CNY: "HK",
};

/**
 * Which region's rates apply. The exchange suffix wins over the currency:
 * a rupee-reporting company listed in New York is discounted by whoever is
 * pricing it, and that is the listing.
 */
export function regionFor(ticker: string, currency?: string | null): Region {
  const suffix = ticker.includes(".") ? ticker.split(".").pop()!.toUpperCase() : "";
  const key = SUFFIX_REGION[suffix]
    ?? (currency ? CURRENCY_REGION[currency] : undefined)
    ?? "US";
  return REGIONS.find((r) => r.key === key) ?? REGIONS[1];
}

export type WaccInputs = {
  /** Market value of equity, in the reporting currency. */
  equity: number;
  /** Total debt at book, in the reporting currency. */
  debt: number;
  /** Cash, netted off only when the user asks for it. */
  cash?: number | null;
  beta: number;
  /** Risk-free rate, percent. */
  rf: number;
  /** Equity risk premium, percent. */
  erp: number;
  /** Pre-tax cost of debt, percent. */
  rd: number;
  /** Tax rate, percent. */
  tax: number;
  /** An extra premium for size, country or company-specific risk, percent. */
  premium?: number;
};

export type WaccResult = {
  /** Cost of equity from CAPM, percent. */
  costOfEquity: number;
  /** After-tax cost of debt, percent. */
  afterTaxDebt: number;
  /** Equity weight, 0–1. */
  we: number | null;
  wd: number | null;
  /** The blended rate, percent. Null when there is no capital to weight. */
  wacc: number | null;
  /** Percentage points of the WACC contributed by each side. */
  equityContribution: number | null;
  debtContribution: number | null;
  /** The tax shield's worth, in percentage points of WACC. */
  taxShield: number | null;
  capital: number;
};

/** CAPM, plus any company-specific premium the user added. */
export function costOfEquity(rf: number, beta: number, erp: number,
                            premium = 0): number {
  return rf + beta * erp + premium;
}

export function waccModel(i: WaccInputs): WaccResult {
  const re = costOfEquity(i.rf, i.beta, i.erp, i.premium ?? 0);
  const rdAfter = i.rd * (1 - i.tax / 100);
  const capital = i.equity + i.debt;

  if (!(capital > 0)) {
    return {
      costOfEquity: re, afterTaxDebt: rdAfter, we: null, wd: null, wacc: null,
      equityContribution: null, debtContribution: null, taxShield: null,
      capital,
    };
  }
  const we = i.equity / capital;
  const wd = i.debt / capital;
  const eq = we * re;
  const dt = wd * rdAfter;
  return {
    costOfEquity: re,
    afterTaxDebt: rdAfter,
    we, wd,
    wacc: eq + dt,
    equityContribution: eq,
    debtContribution: dt,
    // What the deductibility of interest is worth, expressed the same way as
    // the WACC itself so the two are directly comparable.
    taxShield: wd * i.rd * (i.tax / 100),
    capital,
  };
}

// ── sensitivity ───────────────────────────────────────────────────────────

export type Axis = "beta" | "erp" | "rf" | "rd" | "tax" | "leverage";

export const AXES: ReadonlyArray<{ key: Axis; label: string; step: number; unit: string }> = [
  { key: "beta", label: "Beta", step: 0.15, unit: "" },
  { key: "erp", label: "Equity risk premium", step: 0.5, unit: "%" },
  { key: "rf", label: "Risk-free rate", step: 0.5, unit: "%" },
  { key: "rd", label: "Pre-tax cost of debt", step: 0.5, unit: "%" },
  { key: "tax", label: "Tax rate", step: 5, unit: "%" },
  { key: "leverage", label: "Debt / capital", step: 10, unit: "%" },
];

/** The current value of an axis, in the units the axis is displayed in. */
export function axisValue(i: WaccInputs, axis: Axis): number {
  switch (axis) {
    case "beta": return i.beta;
    case "erp": return i.erp;
    case "rf": return i.rf;
    case "rd": return i.rd;
    case "tax": return i.tax;
    case "leverage": {
      const cap = i.equity + i.debt;
      return cap > 0 ? (i.debt / cap) * 100 : 0;
    }
  }
}

/** Inputs with one axis overridden. Leverage is applied by re-splitting the
 *  same total capital, so the enterprise value doesn't change underneath the
 *  grid — otherwise the row would be measuring two things at once. */
export function withAxis(i: WaccInputs, axis: Axis, value: number): WaccInputs {
  if (axis === "leverage") {
    const cap = i.equity + i.debt;
    const share = Math.min(Math.max(value, 0), 100) / 100;
    return { ...i, debt: cap * share, equity: cap * (1 - share) };
  }
  return { ...i, [axis]: value };
}

/** Values either side of the current one, `steps` in each direction. */
export function axisTicks(i: WaccInputs, axis: Axis, steps = 2): number[] {
  const spec = AXES.find((a) => a.key === axis)!;
  const centre = axisValue(i, axis);
  const out: number[] = [];
  for (let s = -steps; s <= steps; s++) {
    let v = centre + s * spec.step;
    // Beta and rates below zero, and a tax rate outside 0–100, are not
    // scenarios — they are arithmetic accidents. Clamp rather than print them.
    if (axis === "beta" || axis === "erp" || axis === "rd") v = Math.max(v, 0);
    if (axis === "tax" || axis === "leverage") v = Math.min(Math.max(v, 0), 100);
    out.push(Number(v.toFixed(4)));
  }
  // Clamping can produce duplicates at an edge; one column per distinct value.
  return [...new Set(out)];
}

export type Grid = {
  rowAxis: Axis;
  colAxis: Axis;
  rows: number[];
  cols: number[];
  /** wacc[row][col], null where the combination has no answer. */
  wacc: (number | null)[][];
  /** The current inputs' cell, for highlighting. */
  centreRow: number;
  centreCol: number;
  min: number | null;
  max: number | null;
};

/**
 * WACC across two axes.
 *
 * The reason this exists rather than a ± range: the two assumptions that move
 * the answer most (beta and the equity risk premium) are the two nobody can
 * observe, and their effects compound. A reader who sees the corner of the
 * grid understands the precision of the centre.
 */
export function sensitivity(i: WaccInputs, rowAxis: Axis, colAxis: Axis,
                            steps = 2): Grid {
  const rows = axisTicks(i, rowAxis, steps);
  const cols = axisTicks(i, colAxis, steps);
  const wacc = rows.map((r) =>
    cols.map((c) => waccModel(withAxis(withAxis(i, rowAxis, r), colAxis, c)).wacc));

  const flat = wacc.flat().filter((v): v is number => v != null);
  const nearest = (ticks: number[], v: number) => {
    let best = 0;
    for (let k = 1; k < ticks.length; k++) {
      if (Math.abs(ticks[k] - v) < Math.abs(ticks[best] - v)) best = k;
    }
    return best;
  };
  return {
    rowAxis, colAxis, rows, cols, wacc,
    centreRow: nearest(rows, axisValue(i, rowAxis)),
    centreCol: nearest(cols, axisValue(i, colAxis)),
    min: flat.length ? Math.min(...flat) : null,
    max: flat.length ? Math.max(...flat) : null,
  };
}

// ── what the rate implies ─────────────────────────────────────────────────

export type Implied = {
  /** Perpetuity multiple on the first year's cash flow: 1 / (WACC − g). */
  multiple: number | null;
  /** Why there is no multiple, when there isn't one. */
  problem: string | null;
};

/**
 * The terminal-value multiple a WACC implies at a given perpetual growth rate.
 *
 * This is where a discount rate becomes intuitive: 9% against 3% growth is a
 * 16.7x multiple on terminal cash flow, and 8% against 4% is 25x. A 100bp
 * error in either input is a 50% error in the valuation, which is the single
 * most useful thing a cost-of-capital screen can tell someone.
 */
export function impliedMultiple(wacc: number | null, growth: number): Implied {
  if (wacc == null) return { multiple: null, problem: "No WACC to work from." };
  if (growth >= wacc) {
    // Not a large number — an undefined one. A perpetuity growing faster than
    // its discount rate has infinite value, which means the model has broken
    // rather than that the company is a wonderful investment.
    return {
      multiple: null,
      problem: `Perpetual growth of ${growth.toFixed(1)}% is at or above the `
        + `WACC of ${wacc.toFixed(1)}%, so the perpetuity has no finite value. `
        + "That is a broken model, not a valuation — no company grows faster "
        + "than the economy forever.",
    };
  }
  const spread = wacc - growth;
  if (spread < 1) {
    return {
      multiple: 100 / spread,
      problem: `The spread between the WACC and growth is only `
        + `${spread.toFixed(1)} points, so the multiple is extremely sensitive: `
        + "a 25bp change in either moves it by roughly a quarter.",
    };
  }
  return { multiple: 100 / spread, problem: null };
}

export type ValueSpread = {
  /** Return on capital minus the cost of it, in percentage points. */
  spread: number | null;
  verdict: "creating" | "destroying" | "at cost" | "unknown";
  read: string;
};

/**
 * Return on capital against the cost of it.
 *
 * The point of the whole screen. A company earning 22% on capital that costs
 * 11% doubles the value of every rupee it reinvests; one earning 8% on capital
 * that costs 11% destroys value by growing, and its "growth story" is a
 * liability. Nothing else on this screen answers that.
 *
 * `roic` arrives as a fraction from the snapshot (0.22), because that is what
 * the provider sends; it is converted here so the caller doesn't have to
 * remember which convention applies.
 */
export function valueSpread(waccPct: number | null,
                            roicFraction: number | null | undefined): ValueSpread {
  if (waccPct == null || roicFraction == null || !Number.isFinite(roicFraction)) {
    return {
      spread: null, verdict: "unknown",
      read: "No return-on-capital figure is available for this listing, so the "
        + "cost of capital can't be compared to what the business earns — "
        + "which is the comparison that matters.",
    };
  }
  const roic = roicFraction * 100;
  const spread = roic - waccPct;
  // A point either side is inside the error bars of every input feeding both
  // numbers, so it is called flat rather than dressed up as a signal.
  if (Math.abs(spread) < 1) {
    return {
      spread, verdict: "at cost",
      read: `Return on capital of ${roic.toFixed(1)}% is within a point of the `
        + `${waccPct.toFixed(1)}% cost of capital. Growth neither creates nor `
        + "destroys value at that level, and the gap is inside the error bars "
        + "of both figures anyway.",
    };
  }
  if (spread > 0) {
    return {
      spread, verdict: "creating",
      read: `Return on capital of ${roic.toFixed(1)}% clears the `
        + `${waccPct.toFixed(1)}% cost of capital by ${spread.toFixed(1)} `
        + "points, so reinvested profit adds value and growth is worth paying "
        + "for. Whether the spread persists is the actual question — "
        + "competition closes most of them.",
    };
  }
  return {
    spread, verdict: "destroying",
    read: `Return on capital of ${roic.toFixed(1)}% is ${(-spread).toFixed(1)} `
      + `points BELOW the ${waccPct.toFixed(1)}% cost of capital. On these `
      + "numbers the business destroys value by growing, and a growth story "
      + "here is a reason for concern rather than a reason to pay up.",
  };
}

// ── sanity checks ─────────────────────────────────────────────────────────

export type Flag = { severity: "warn" | "note"; text: string };

/**
 * The inputs that are quietly implausible.
 *
 * Every one of these produces a WACC that computes fine and means nothing, and
 * a reader driving a valuation off it would never know. Cheaper to say so.
 */
export function waccFlags(i: WaccInputs, r: WaccResult): Flag[] {
  const out: Flag[] = [];

  if (i.rd > 0 && i.rd < i.rf) {
    out.push({
      severity: "warn",
      text: `The cost of debt (${i.rd.toFixed(1)}%) is below the risk-free rate `
        + `(${i.rf.toFixed(1)}%). No corporate borrows below its government, so `
        + "one of the two is wrong.",
    });
  }
  if (i.beta <= 0) {
    out.push({
      severity: "warn",
      text: "A beta at or below zero makes the cost of equity lower than the "
        + "risk-free rate, which means the model is saying equity holders "
        + "demand less than a government bond.",
    });
  }
  if (i.beta > 2) {
    out.push({
      severity: "note",
      text: `A beta of ${i.beta.toFixed(2)} is high enough that it is probably a `
        + "regression artefact — a thin-volume listing or a short window. Check "
        + "it before discounting anything with it.",
    });
  }
  if (i.debt <= 0) {
    out.push({
      severity: "note",
      text: "No debt in the structure, so the WACC is just the cost of equity "
        + "and the tax shield contributes nothing.",
    });
  }
  if (r.wd != null && r.wd > 0.7) {
    out.push({
      severity: "warn",
      text: `Debt is ${(r.wd * 100).toFixed(0)}% of capital. At that leverage the `
        + "cost of debt is not independent of the amount borrowed and the beta "
        + "understates equity risk, so both inputs are optimistic.",
    });
  }
  if (i.tax <= 0) {
    out.push({
      severity: "note",
      text: "A zero tax rate removes the interest shield entirely — correct for "
        + "a loss-maker, wrong for anyone paying tax.",
    });
  }
  if (i.equity <= 0) {
    out.push({
      severity: "warn",
      text: "No equity value, so the weights are meaningless. Market cap didn't "
        + "load for this listing — enter it before reading the WACC.",
    });
  }
  return out;
}

/** The plain-language caveat, in the house style. */
export function waccNote(region: Region, grid: Grid | null): string {
  const parts = [
    `Rates start from ${region.label} defaults (${region.rf.toFixed(1)}% `
      + `risk-free, ${region.erp.toFixed(1)}% equity risk premium, `
      + `${region.tax.toFixed(1)}% tax) picked from the listing's exchange. `
      + "They are round anchors, not today's quotes — overwrite them with your "
      + "own.",
  ];
  if (grid?.min != null && grid.max != null) {
    parts.push(`Across the grid the WACC runs ${grid.min.toFixed(1)}% to `
      + `${grid.max.toFixed(1)}%. That spread is the honest precision of this `
      + "number: the two inputs that move it most are the two nobody can "
      + "observe, and the centre cell is not more true than the corners.");
  }
  parts.push("Beta is a backward-looking regression whose value changes with "
    + "the window and index chosen, debt is at book rather than market, and "
    + "leases and other off-balance-sheet obligations are absent unless the "
    + "filing capitalised them. This is a model, not a measurement.");
  return parts.join(" ");
}
