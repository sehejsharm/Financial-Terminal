/** How every model-derived number on this terminal is actually computed.
 *
 *  The Volatility Cone and Backtest screens already state their assumptions
 *  inline, and that is the most valuable thing about them: you can tell
 *  whether the number applies to your question before you use it. Bloomberg
 *  mostly gives you the figure and expects you to know the convention.
 *
 *  This registry makes that treatment uniform. Anything the app CALCULATES
 *  or GENERATES — a WACC, a Greek, a stress result, a sector rating, an LLM
 *  map — carries a `Methodology` entry saying what it is, what goes into it,
 *  what it assumes, and what it does not capture. It is data rather than
 *  prose scattered through components so it can be reviewed in one place and
 *  can't drift out of sync with the screen it describes.
 *
 *  The `limits` field is the one that matters. Every model here is wrong in
 *  a specific, knowable way, and saying so is what makes the number usable.
 */

export type Methodology = {
  /** What this number is, in one sentence. */
  what: string;
  /** The formula, written how a human would write it. */
  formula?: string;
  /** Each input and where it came from. */
  inputs: string[];
  /** What has to be true for the number to mean what it says. */
  assumptions: string[];
  /** What it does NOT capture. Never empty. */
  limits: string[];
  /** "computed" — arithmetic we do; "model" — a pricing/statistical model;
   *  "ai" — a language model generated it. */
  kind: "computed" | "model" | "ai";
};

export const METHODOLOGY: Record<string, Methodology> = {
  wacc: {
    kind: "model",
    what: "The blended annual rate a company pays for its capital, used as "
      + "the discount rate in a DCF.",
    formula: "WACC = E/V × (rf + β × ERP) + D/V × rd × (1 − tax)",
    inputs: [
      "E — market capitalisation from the live quote and share count.",
      "D — total debt from the latest reported balance sheet.",
      "β — the provider's levered beta, typically against a local index over "
        + "five years of monthly returns.",
      "rf, the equity risk premium and the tax rate — your inputs, with "
        + "regional defaults pre-filled.",
    ],
    assumptions: [
      "CAPM holds: expected equity return is linear in beta.",
      "Today's capital structure is the one that persists.",
      "The cost of debt is constant across the whole debt stack.",
      "The marginal tax rate equals the effective one.",
    ],
    limits: [
      "Beta is a backward-looking regression, and the number changes "
        + "materially with the window and index chosen.",
      "Off-balance-sheet obligations (leases, guarantees) are not in D unless "
        + "the filing capitalised them.",
      "The equity risk premium is not observable; it is an assumption you are "
        + "choosing, and the output moves roughly one-for-one with it.",
      "No country or size premium is applied.",
    ],
  },

  greeks: {
    kind: "model",
    what: "Black–Scholes sensitivities of an option position to price, time, "
      + "volatility and rates.",
    formula: "Black–Scholes–Merton, European exercise, continuous dividends",
    inputs: [
      "Spot from the live quote; strike, expiry and side from the position.",
      "Implied volatility from the chain where the provider publishes it, "
        + "otherwise your input.",
      "Risk-free rate — your input.",
    ],
    assumptions: [
      "Returns are lognormal with constant volatility to expiry.",
      "European exercise: no early assignment.",
      "Continuous, frictionless hedging, no transaction costs.",
    ],
    limits: [
      "Real return distributions have fatter tails than lognormal, so far "
        + "out-of-the-money risk is understated.",
      "Volatility is not constant — a single IV cannot represent a skewed "
        + "surface, and these Greeks assume it can.",
      "Indian index options are European, but single-stock options are "
        + "American; early exercise is not modelled.",
      "Greeks are instantaneous. They are wrong the moment anything moves, "
        + "and second-order effects are not shown except gamma.",
    ],
  },

  stress: {
    kind: "computed",
    what: "What this book would have done under a chosen shock.",
    inputs: [
      "Historical replay: each holding's own returns across the dated window.",
      "Factor shock: your percentage move, applied through each holding's "
        + "beta to the index.",
      "Position sizes and prices from the portfolio as it stands now.",
    ],
    assumptions: [
      "Positions are held unchanged through the whole episode — no trading, "
        + "no rebalancing, no stops.",
      "Historical replay assumes a security behaves as it did then, which "
        + "presumes the business is comparable.",
      "The factor shock assumes beta is stable, which is exactly what stops "
        + "being true in a crash.",
    ],
    limits: [
      "Coverage is stated per run: holdings without history for the window "
        + "are excluded, not estimated, and the result covers only the rest.",
      "Correlations rise towards one in real crises; a beta-based shock "
        + "understates that.",
      "Liquidity, gap risk and margin calls are not modelled at all.",
      "A replay is one path that happened, not a distribution of what could.",
    ],
  },

  sectorRating: {
    kind: "computed",
    what: "A bull/bear score for a sector index, from six price measurements.",
    formula: "score = Σ(weight × component), renormalised over what is measurable",
    inputs: [
      "One year of the sector index's own closes.",
      "NIFTY 50 closes over the same window, for relative strength.",
      "Today's change for a representative sample of constituents, for breadth.",
    ],
    assumptions: [
      "Price contains the information — no fundamentals enter the score.",
      "The saturation points (10 points of relative strength, 20% below the "
        + "high) are judgement calls, stated so you can disagree with them.",
    ],
    limits: [
      "Five of the six components are trend-following, so the rating turns "
        + "late at every inflection.",
      "Breadth uses a representative sample, not official index membership, "
        + "which is why it carries the lightest weight.",
      "Nothing here is valuation. A sector can score well and be expensive.",
      "It describes what price has done, and is not a forecast.",
    ],
  },

  riskMetrics: {
    kind: "computed",
    what: "Distribution and drawdown statistics for a return series.",
    inputs: [
      "Period returns from the same history feed the charts use.",
      "Your periods-per-year setting, which drives every annualised figure.",
      "The risk-free rate, converted to a period rate before subtraction.",
    ],
    assumptions: [
      "Returns are independent across periods — which is what allows scaling "
        + "volatility by the square root of time.",
      "The sample window is representative of the risk being measured.",
    ],
    limits: [
      "Sharpe assumes a symmetric distribution and penalises upside "
        + "volatility identically to downside.",
      "VaR and CVaR here are historical, not modelled: they cannot show you "
        + "a loss bigger than the worst one in the sample.",
      "Fewer than twenty observations returns nothing rather than a figure "
        + "computed from noise.",
      "Past distribution is not future distribution, and drawdowns in "
        + "particular cluster in ways a single sample understates.",
    ],
  },

  valueChain: {
    kind: "ai",
    what: "Suppliers, customers and competitors for a company, generated by a "
      + "language model.",
    inputs: [
      "The company's resolved identity, sector and industry — from market "
        + "data, not from the model's memory.",
      "The model's training data for the relationships themselves.",
    ],
    assumptions: [
      "The model knows the industry structure well enough to name real "
        + "counterparties.",
      "Revenue shares it attaches are estimates, and it says so per edge.",
    ],
    limits: [
      "This is generated content, not sourced from filings. Nothing is "
        + "verified against a document unless it carries a ✓ verified mark, "
        + "which means an admin checked it.",
      "The model has a training cutoff: recent contract wins, disposals and "
        + "failures may be missing or wrong.",
      "It can name a plausible company that is not actually a counterparty. "
        + "Flag anything that looks wrong — flags feed a review queue.",
      "Revenue percentages are the least reliable part; treat them as "
        + "ordering, not as measurements.",
    ],
  },

  financials: {
    kind: "computed",
    what: "Growth, common-size, ratios and quality checks derived from the "
      + "three reported statements.",
    formula: "Every ratio prints its own formula beside it on the Ratios tab.",
    inputs: [
      "Income statement, balance sheet and cash flow as reported, from FMP "
        + "where it covers the listing and yfinance otherwise.",
      "Nothing else. No estimate, model or peer figure enters this screen.",
    ],
    assumptions: [
      "Line items mean the same thing across providers — the screen matches "
        + "them by meaning, not by label, because the two name them "
        + "differently.",
      "Periods are comparable. A change of fiscal year end or an acquisition "
        + "makes a growth rate misleading and the statements do not say so.",
      "Where gross profit or free cash flow is absent it is derived from "
        + "lines that ARE present (revenue less cost of revenue; operating "
        + "cash flow plus capex). That is arithmetic, not an estimate.",
    ],
    limits: [
      "Ratios use only periods present in ALL the statements they need. A "
        + "year in one statement and missing from another is left out rather "
        + "than mixed with a neighbouring period.",
      "Interest cover is inferred from the gap between operating and pre-tax "
        + "income, because neither provider gives an interest line. That gap "
        + "also holds other non-operating items, so it is approximate.",
      "Reported figures are not adjusted: one-off gains, impairments and "
        + "changes in accounting policy all sit inside these numbers "
        + "unmarked.",
      "Quality flags are six specific checks, not an audit. Nothing flagged "
        + "means those six did not fire — it is not a clean bill of health.",
      "Free-tier coverage is uneven: Indian listings frequently have no "
        + "statements at all, which is a gap in the data rather than in the "
        + "company.",
    ],
  },

  comparables: {
    kind: "computed",
    what: "Where this company's multiples sit against a peer set.",
    formula: "premium = (value − peer median) / |peer median|",
    inputs: [
      "Trailing and forward P/E, P/B, P/S, an EV/EBITDA proxy and ROE for "
        + "every name in the set.",
      "The peer list — auto-selected by sector and exchange, and editable.",
    ],
    assumptions: [
      "The peers are actually comparable. Sector and exchange is a crude "
        + "screen and the list is editable for exactly that reason.",
      "The MEDIAN is the fair reference, not the mean: one peer whose "
        + "earnings collapsed carries a P/E that would drag a mean somewhere "
        + "useless and make everything else look cheap.",
    ],
    limits: [
      "No adjustment for growth, leverage, returns or accounting policy. "
        + "Peers with different fundamentals SHOULD trade at different "
        + "multiples, so a discount here is a question, not an answer.",
      "EV/EBITDA uses market cap as the enterprise-value proxy — the free "
        + "feed has no debt layer for peers — so an indebted peer looks "
        + "cheaper on that column than it is.",
      "A multiple more than five times the peer median is nulled rather than "
        + "shown: at that distance it is almost always a provider error.",
      "Below three reporting peers no comparison is made at all; a median of "
        + "two is not a market view.",
    ],
  },

  street: {
    kind: "computed",
    what: "The analyst consensus, its distribution, and how both have moved.",
    formula: "score = Σ(ratings × 1..5) / count, where 1 is strong buy",
    inputs: [
      "The provider's recommendation counts per bucket, by month.",
      "Published price targets: low, mean, high and the current price.",
    ],
    assumptions: [
      "Bucket names map cleanly across providers — outperform and overweight "
        + "are read as buy, neutral as hold.",
    ],
    limits: [
      "Ratings are a poor timing signal. The street is structurally long, so "
        + "'hold' is closer to a negative view than the word suggests and the "
        + "distribution is skewed before you read it.",
      "Targets follow the price more often than they lead it, so a wide "
        + "implied upside after a fall is not by itself a signal.",
      "No analyst count comes with the targets on the free feed: a mean set "
        + "by two analysts and one set by thirty are indistinguishable here.",
      "Coverage changes are visible; WHO changed their mind is not.",
    ],
  },

  ownership: {
    kind: "computed",
    what: "How concentrated the disclosed share register is.",
    formula: "top-5 share, largest single stake, and an HHI over the stakes",
    inputs: [
      "Institutional and mutual-fund holdings as disclosed to the provider.",
    ],
    assumptions: [
      "The percentage column is a share of the company. Providers send it as "
        + "either a fraction or a percentage, and the scale is inferred from "
        + "the whole column rather than row by row.",
    ],
    limits: [
      "These are DISCLOSED institutional stakes only. They do not sum to "
        + "100% — promoters, retail and everyone below the disclosure "
        + "threshold are simply absent.",
      "Filings lag by weeks to months, so the register shown is not the "
        + "register today, and a position may already be gone.",
      "No history: the screen shows who holds it, not who has been buying, "
        + "which is usually the more interesting question.",
      "Free-tier coverage of Indian promoters is poor, so an Indian listing "
        + "can look institution-free when it is closely held.",
    ],
  },

  chainExposure: {
    kind: "computed",
    what: "Concentration, money at risk, and whether the resulting trade can "
      + "actually be executed at the intended size.",
    formula: "HHI = Σ(share²) · at risk = share × (revenue or cost of revenue) "
      + "· sessions = notional / (ADV × participation)",
    inputs: [
      "Relationship shares from the value-chain map — the model's estimates "
        + "unless an edge is marked verified.",
      "The subject's revenue and cost of revenue, where the providers carry "
        + "them; otherwise the model's own estimated relationship values.",
      "Twenty sessions of daily bars per listed counterparty, for average "
        + "daily value traded.",
      "Your chosen notional and a 15% participation assumption.",
    ],
    assumptions: [
      "Shares are normalised over what is QUANTIFIED, not over 100 — the map "
        + "covers the largest relationships it knows about, not the whole book.",
      "A supplier's share applies to cost of revenue and a customer's to "
        + "revenue; the two are never added together.",
      "Liquidity is stable at recent levels, and 15% of a day's volume is an "
        + "upper bound for a patient order rather than a target.",
      "The position is spread in proportion to exposure, which is a sizing "
        + "convention and not a recommendation.",
    ],
    limits: [
      "Because the map is partial, real concentration is AT LEAST what is "
        + "shown here and never less. Treat every concentration figure as a "
        + "floor.",
      "No market impact is modelled. The day counts assume your buying does "
        + "not move the price, which stops being true at exactly the sizes "
        + "this screen is for.",
      "Borrow availability, position limits, index-inclusion effects and the "
        + "fact that other participants can see the same liquidity are all "
        + "absent.",
      "Money at risk is what a relationship is worth, not what would be lost: "
        + "a disrupted supplier is usually replaced at a higher price, not at "
        + "zero output.",
      "Private and unlisted counterparties carry no ticker, so they are "
        + "excluded from the trade plan while still being real exposure.",
    ],
  },

  aiAnalysis: {
    kind: "ai",
    what: "A written analysis produced by a language model from the figures on "
      + "this screen.",
    inputs: [
      "The quantitative data already shown on the page.",
      "The model's general knowledge of how to read those figures.",
    ],
    assumptions: [
      "The underlying data is correct — the model does not verify it.",
    ],
    limits: [
      "It can be fluent and wrong, and fluency is not evidence.",
      "It has no access to anything after its training cutoff except the "
        + "figures passed to it.",
      "It is not investment advice, and it has no knowledge of your "
        + "position, horizon or constraints.",
      "Two runs can disagree. If a conclusion matters, check the numbers it "
        + "was given.",
    ],
  },
};

export type MethodologyKey = keyof typeof METHODOLOGY;
