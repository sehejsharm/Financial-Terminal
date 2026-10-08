/** The sentences that must read identically everywhere they appear.
 *
 *  Three surfaces state this product's regulatory position: the app-wide
 *  footer, /disclosures, and the public landing page. Three copies of a
 *  sentence drift, and the one that drifts is the one nobody reads until it
 *  matters.
 *
 *  The registration line is the reason this file exists. If the open question
 *  in docs/COMPLIANCE.md §1.1 resolves to "registered", this constant carries
 *  the registration details instead and all three surfaces update together —
 *  rather than someone grepping for a sentence they half-remember.
 */

/** SEBI's market-risk wording. VERBATIM — docs/COMPLIANCE.md §2.1 records that
 *  it must not be paraphrased, so it lives here as a single string rather than
 *  being retyped into each page. */
export const MARKET_RISK = "Investments in securities market are subject to "
  + "market risks. Read all the related documents carefully before investing.";

/** The regulatory position, as one sentence.
 *
 *  Conservative on purpose: understating credentials we may have is
 *  survivable, while holding ourselves out as a registered intermediary when
 *  we are not is an offence. If registration is obtained, change this. */
export const REGISTRATION_STATUS = "Motherboard Terminal is not registered "
  + "with SEBI as a Research Analyst or an Investment Adviser, and is not a "
  + "stock broker, portfolio manager or distributor of any financial product.";

/** What the product does not do. The same list /disclosures carries, because
 *  a second variant would be a second thing to keep true. */
export const WHAT_THIS_IS_NOT = [
  "It does not provide personalised investment advice.",
  "It does not make recommendations to buy or sell any security.",
  "It does not manage money or execute trades.",
  "Nothing on this site is a solicitation or an offer.",
] as const;

/** Where the numbers come from, and that they can be wrong. Understating data
 *  quality is safe under either resolution of §1.1, and it happens to be the
 *  most useful thing we can tell a prospective user. */
export const DATA_HONESTY = "Prices and fundamentals come from public sources "
  + "— NSE's own website, Twelve Data, Financial Modeling Prep, Yahoo Finance, "
  + "company filings published as XBRL, and FRED. None of it is a licensed "
  + "real-time feed, which is why the app labels prices as public data rather "
  + "than live. Figures can be wrong: providers mis-map tickers after "
  + "corporate actions, restate history without notice, and return nothing at "
  + "all for thinly traded names. Verify anything you would act on against "
  + "the company's own filing or your broker's terminal.";

/** The conflicts position.
 *
 *  This is a factual claim about the business, not a policy — so it can stop
 *  being true. It needs re-reading at every marketing change, not once. */
export const CONFLICTS = "Motherboard Terminal earns money from "
  + "subscriptions only. It is not paid by any issuer, broker, exchange, "
  + "asset manager or distributor, takes no commission or brokerage, and runs "
  + "no advertising. No company can pay to appear, rank higher, or be "
  + "excluded from a screen.";

/** The one contact address the public pages print.
 *
 *  Env-driven and shared, because it was previously hardcoded twice — as
 *  `privacy@your-domain.example` on /privacy and `support@your-domain.example`
 *  on /terms, both marked TODO. Those pages are now indexed, so the
 *  placeholders are the contact details a search result would show.
 *
 *  The default is a `.invalid` domain on purpose: .invalid is reserved and can
 *  never resolve, so an unset deploy fails visibly rather than printing an
 *  address that looks plausible and bounces. MUST be set before launch — see
 *  docs/COMPLIANCE.md §3.
 */
export const CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_GRIEVANCE_EMAIL || "support@motherboard.invalid";
