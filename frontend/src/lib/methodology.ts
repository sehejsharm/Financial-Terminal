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
      "rf, the equity risk premium, the cost of debt and the tax rate — your "
        + "inputs, pre-filled from the listing's exchange (Indian, US, UK, "
        + "euro-area, Japanese or Hong Kong rate sets).",
      "ROCE for the spread comparison — the provider's figure, or EBIT over "
        + "capital employed computed from the statements when they don't carry "
        + "one.",
    ],
    assumptions: [
      "CAPM holds: expected equity return is linear in beta.",
      "Today's capital structure is the one that persists.",
      "The cost of debt is constant across the whole debt stack, and "
        + "independent of how much is borrowed — which stops being true at "
        + "high leverage.",
      "The marginal tax rate equals the effective one.",
      "The regional rate defaults are round anchors, not today's quotes. They "
        + "are there to be overwritten.",
    ],
    limits: [
      "Beta is a backward-looking regression, and the number changes "
        + "materially with the window and index chosen.",
      "Off-balance-sheet obligations (leases, guarantees) are not in D unless "
        + "the filing capitalised them, and D is at book rather than market.",
      "The equity risk premium is not observable; it is an assumption you are "
        + "choosing, and the output moves roughly one-for-one with it. That is "
        + "why the sensitivity grid is there — the centre cell is not more "
        + "true than the corners.",
      "The country or size premium is whatever you type into the extra-premium "
        + "field; nothing is applied automatically.",
      "The terminal multiple is a plain perpetuity, 1/(WACC − g). It has no "
        + "finite value once growth reaches the discount rate, and the screen "
        + "refuses rather than printing a very large number.",
      "The ROCE spread compares a single trailing year against a forward-"
        + "looking cost of capital. A spread that exists today is not a spread "
        + "that persists — competition closes most of them.",
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

  optionChain: {
    kind: "computed",
    what: "What the chain is pricing: the move implied by expiry, the cost of "
      + "protection against participation, where open interest sits, and "
      + "whether any of it can be traded at the prices shown.",
    formula: "expected move = (ATM call + ATM put) / spot · skew = 10% OTM put "
      + "IV − 10% OTM call IV · spread = (ask − bid) / mid",
    inputs: [
      "The chain rows already on the page — bids, asks, last prices, volume, "
        + "open interest and the provider's implied volatilities.",
      "Mid prices where both sides are quoted; the last trade only as a "
        + "fallback, because a last price on a contract that didn't trade "
        + "today is history rather than a quote.",
    ],
    assumptions: [
      "The at-the-money straddle prices the expected move. That holds well "
        + "enough at the money and gets worse the further out you go.",
      "The two nearest strikes must be the SAME strike — a call at one strike "
        + "against a put at another is a strangle, and the screen refuses to "
        + "price it as a straddle.",
      "The provider's implied volatilities are comparable across strikes, "
        + "which requires them to have been fitted consistently.",
    ],
    limits: [
      "The expected move is roughly a one-standard-deviation range, so it is "
        + "wrong about a third of the time by construction. It is not a bound.",
      "Open-interest walls say where flow concentrates because dealers hedge "
        + "there. They do not say where price goes, and open interest never "
        + "reveals which side initiated a position — a put is as likely to be "
        + "a hedge on a long as a bet on a fall.",
      "Equity chains are almost always put-skewed, so the sign of the skew is "
        + "not information; only its size, and a call-skewed chain, are.",
      "Free option feeds thin out fast away from the money. A skew or a wall "
        + "read off two quoted contracts is not a surface.",
      "Where the median spread is wide, any edge a Greeks model identifies "
        + "that is smaller than the spread does not exist.",
    ],
  },

  bookAnalytics: {
    kind: "computed",
    what: "How concentrated the book is, which positions moved it, and which "
      + "holdings supply its market sensitivity.",
    formula: "HHI = Σ(weight²) · effective positions = 1 / HHI · share of "
      + "movement = |position P&L| / Σ|position P&L| · beta contribution = "
      + "weight × beta",
    inputs: [
      "Position quantities and average cost from your own entries.",
      "Live prices where the socket has them, the REST snapshot otherwise.",
      "Each holding's provider beta and sector.",
    ],
    assumptions: [
      "Weights are market value, so concentration reads exposure as it stands "
        + "rather than as it was bought.",
      "Beta is normalised over the holdings that HAVE one, not over the whole "
        + "book — dividing by total value would understate it in proportion to "
        + "the provider's gaps.",
      "Share of movement is measured against the sum of absolute P&L. Against "
        + "the net it is unbounded: a winner offset by a loser would report "
        + "1,000% and −900%.",
    ],
    limits: [
      "Correlation between holdings is not measured. Twenty names in one "
        + "industry is one bet however the effective count reads, which is why "
        + "the sector figure is shown beside it.",
      "P&L is unrealised, against average cost. It excludes closed positions, "
        + "dividends received and every cost of trading, so it is not a return.",
      "Each beta is a backward-looking regression against whichever index and "
        + "window the provider chose. Betas also converge upward in a selloff, "
        + "so this understates the book's behaviour in exactly the conditions "
        + "it is consulted about.",
      "A mixed-currency book is summed without conversion — the totals are not "
        + "single-currency figures and are shown unsymboled when that is the "
        + "case.",
      "Nothing here knows your horizon, your other assets, or what the "
        + "positions are for.",
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

  technicals: {
    kind: "computed",
    what: "What each indicator currently reads, in words, plus the swing "
      + "levels directly above and below the price.",
    formula: "textbook definitions throughout · levels = swing pivots (5 bars "
      + "either side) clustered within 1.5%",
    inputs: [
      "Only the daily bars the chart has loaded for the selected period — no "
        + "extra request, and the readings move when you change the period.",
      "Wilder's smoothing for RSI, ATR, ADX and MFI, which is what a terminal "
        + "uses; an EMA in its place gives numbers that look close and never "
        + "match.",
    ],
    assumptions: [
      "The conventional thresholds (RSI 70/30, stochastic 80/20, ADX 25) mean "
        + "the same thing across every name and regime, which is a convenience "
        + "rather than a fact.",
      "A swing pivot that three separate swings agree on is a level; three "
        + "lines within 1.5% of each other are one level, not three.",
    ],
    limits: [
      "The bull/bear figure is a COUNT, not a score. Most of these indicators "
        + "are functions of the same few moving averages, so several agreeing "
        + "is often one observation repeated rather than independent "
        + "confirmation.",
      "Every indicator here is computed from past prices alone. They describe "
        + "what has happened, and all of them turn late.",
      "ADX, ATR and Bollinger position carry no direction and are reported "
        + "rather than scored — a high ADX in a downtrend is not bullish, and "
        + "price rides the upper band throughout an advance.",
      "Levels come from this window's bars only, so a different chart period "
        + "produces different levels. Volume traded at a level matters more "
        + "than the level itself, and that is not modelled here.",
      "Gaps, splits handled by the provider, and thin-volume prints all feed "
        + "straight through. Nothing here knows about earnings dates, index "
        + "rebalances or anything else that explains a move.",
    ],
  },

  wireDigest: {
    kind: "computed",
    what: "Which listed companies the wire is writing about, what subject keeps "
      + "recurring, and whether the feeds are actually reporting.",
    formula: "whole-word alias matching against a fixed universe · two-word "
      + "phrases counted once per story",
    inputs: [
      "The headlines and summaries already on the page — no extra request, no "
        + "model.",
      "A fixed universe of the NIFTY 50 plus a few frequently written-about "
        + "listings, each with the aliases headlines actually use (“HDFC Bank”, "
        + "not the registered name).",
    ],
    assumptions: [
      "A company is mentioned when a headline contains its name or a known "
        + "alias as whole words. Substring matching would tag “Titan” inside "
        + "“titanium”.",
      "A recurring two-word phrase names a subject. Single words are too "
        + "blunt — “rate” covers rate cut, rate hike and exchange rate — and "
        + "longer phrases are too sparse to recur.",
    ],
    limits: [
      "The universe is FIXED. A company outside it is never tagged, so the "
        + "counts are a floor rather than a census of what is in the news.",
      "Group words (“Tata”, “Adani”, “Bajaj”) are deliberately not matched on "
        + "their own — each names several listed companies, and pinning a group "
        + "story to one of them fabricates a link.",
      "Themes describe what is being written about, which is not the same as "
        + "what matters. Coverage volume follows price moves that have already "
        + "happened.",
      "Counts are per story after clustering, so a syndicated piece is one "
        + "observation — but two outlets covering the same event independently "
        + "still count twice.",
      "A silent feed is reported because a quiet page with sources down looks "
        + "identical to a quiet market. It cannot tell you WHY a feed is "
        + "silent.",
    ],
  },

  newsSentiment: {
    kind: "ai",
    what: "A language model's read on the tone of each headline, averaged.",
    formula: "score = (bullish − bearish) / tagged",
    inputs: [
      "The headlines on screen, after the entity filter has decided which "
        + "stories are about this company.",
      "Nothing else: no price, no fundamentals, no article body beyond the "
        + "summary the feed provides.",
    ],
    assumptions: [
      "A headline's tone is a reasonable proxy for its content, which is "
        + "generous to headline writers.",
      "Every story counts equally. A hundred reprints of one press release "
        + "outweigh a single genuinely important piece.",
    ],
    limits: [
      "It measures TONE, not importance, and certainly not what happens next.",
      "Coverage volume follows the price. A bearish tally after a fall is "
        + "usually the fall being reported, so the score lags by construction.",
      "Only tagged items count. Where coverage is partial, the score describes "
        + "a subset of the list and the screen says what share.",
      "Two runs can disagree — the model is not deterministic, and a borderline "
        + "headline can flip.",
      "It is not a recommendation and knows nothing about your position.",
    ],
  },

  aiAnalysis: {
    kind: "ai",
    what: "A written analysis produced by a language model from the figures on "
      + "this screen.",
    inputs: [
      "A fixed set of fundamentals from this app's own providers, listed in "
        + "full under the analysis — that list IS the whole of what the model "
        + "was told about the company.",
      "The model's general knowledge of how to read those figures.",
    ],
    assumptions: [
      "The underlying data is correct — the model does not verify it.",
      "The figures are formatted before they reach the prompt (₹17.77T rather "
        + "than 17768137097216), so the narrative quotes them the way the rest "
        + "of the app displays them.",
    ],
    limits: [
      "It can be fluent and wrong, and fluency is not evidence.",
      "It has no access to anything after its training cutoff except the "
        + "figures passed to it — no filings, no transcripts, no news.",
      "Fields the providers didn't supply are named as missing. A model with no "
        + "margin figure will still write a paragraph about profitability, and "
        + "that paragraph carries no information.",
      "Any number in the prose that is not in the input list was produced by "
        + "the model rather than read from data.",
      "It is not investment advice, and it has no knowledge of your "
        + "position, horizon or constraints.",
      "Two runs can disagree. Regenerating is worth doing: a second run that "
        + "contradicts the first tells you the conclusion was never in the "
        + "figures.",
    ],
  },
};

export type MethodologyKey = keyof typeof METHODOLOGY;
