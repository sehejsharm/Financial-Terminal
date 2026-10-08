import Link from "next/link";
import type { Metadata } from "next";

import {
  CONFLICTS, DATA_HONESTY, MARKET_RISK, REGISTRATION_STATUS, WHAT_THIS_IS_NOT,
} from "@/lib/compliance";

/**
 * The public landing page.
 *
 * A SERVER component, deliberately — unlike every other page in this app. The
 * whole point is that a crawler and a first-time visitor get the content
 * without running any JavaScript, which is exactly what the rest of the app
 * cannot do (measured: "/" serves 1396 characters of indexable text and all of
 * it is nav chrome).
 *
 * WHAT IS AND IS NOT CLAIMED HERE, AND WHY
 *
 * Every candidate feature claim written for this page was adversarially
 * checked against the code by three independent lenses — is it literally true,
 * is it compliant under either resolution of the open SEBI question, does the
 * cited code actually substantiate it. NONE SURVIVED. Four were refuted
 * outright (a widget count that was wrong; "your layouts follow you between
 * machines", which was only half true; "every computed number tells you where
 * it came from", which does not hold across the methodology registry) and the
 * rest were never verified.
 *
 * So this page is built from the conservative intersection instead: mechanical
 * descriptions of what the software computes, the negatives stated plainly,
 * and the data-provenance honesty that is the actual differentiator. No
 * numbers, no performance figures, no price, no testimonials, no superlatives,
 * no comparative claims. src/lib/__tests__/marketingCopy.test.ts enforces that
 * as a banned-phrase list, because a marketing page sits outside the
 * labelling the app enforces internally.
 *
 * The price is absent on purpose: docs/COMPLIANCE.md §1.4 records Rs 499 as a
 * placeholder with GST treatment unresolved, and a published price is a
 * representation to a consumer.
 */

export const metadata: Metadata = {
  title: "A markets terminal that tells you where its numbers came from",
  description:
    "A research terminal for Indian and global equities. Fundamentals parsed "
    + "from filings, screeners, portfolio tracking and backtesting — with "
    + "every figure labelled by its source. Not investment advice.",
  alternates: { canonical: "/product" },
  // The root layout defaults to noindex because every other route is an
  // auth-gated shell. This is the one page that exists to be found.
  robots: { index: true, follow: true },
  openGraph: {
    url: "/product",
    title: "Motherboard Terminal",
    description:
      "A markets research terminal for Indian and global equities, with every "
      + "figure labelled by where it came from.",
  },
};

function Section({ id, heading, children }: {
  id: string; heading: string; children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mb-10">
      <h2 id={id} className="text-sm font-semibold mb-3">{heading}</h2>
      <div className="text-[12.5px] leading-relaxed text-mut flex flex-col gap-2">
        {children}
      </div>
    </section>
  );
}

/** What the software computes. Phrased as calculators over data the user can
 *  see — never as output that tells the user what to do, which is the line
 *  that matters while the SEBI question is open. */
const WHAT_IT_DOES = [
  {
    name: "Company research",
    body: "Income statement, balance sheet and cash flow, parsed from the "
      + "filings companies publish as XBRL rather than retyped. Consolidated "
      + "and standalone are kept distinct, and quarterly figures are "
      + "de-cumulated into discrete quarters where the filing reports them "
      + "year-to-date.",
  },
  {
    name: "Screeners",
    body: "Filters you define, applied to the data as received. The screen "
      + "reports what it could not evaluate instead of quietly dropping a "
      + "company for missing data, because a filter that silently excludes "
      + "half the market looks identical to one that found nothing.",
  },
  {
    name: "Portfolio tracking",
    body: "Your holdings, their weights, and what the figures imply about "
      + "concentration and sector exposure. You enter the positions; nothing "
      + "is connected to a broker and no trade is ever placed.",
  },
  {
    name: "Options analysis",
    body: "Build a position from legs and see the payoff at expiry and the "
      + "Greeks under stated assumptions. The assumptions are listed next to "
      + "the output, including the ones the model cannot capture.",
  },
  {
    name: "Backtesting",
    body: "Run a rule you specify over historical bars, with a trading-cost "
      + "assumption you set. Past performance is not indicative of future "
      + "results, and the output describes what a rule would have done, which "
      + "is not evidence of what it will do.",
  },
  {
    name: "Alerts",
    body: "Notifications on conditions you configure yourself — a price "
      + "level, a move, a result date. They tell you a condition you chose "
      + "has been met. They do not tell you to do anything about it.",
  },
] as const;

export default function ProductPage() {
  return (
    <div className="min-h-dvh max-w-2xl mx-auto px-5 py-12">
      <header className="mb-10">
        <div className="text-amber font-bold tracking-[0.22em] text-xl mb-1">
          MOTHERBOARD
        </div>
        <div className="label-xs mb-7">Markets research terminal</div>

        <h1 className="text-lg font-semibold leading-snug mb-3">
          Most retail tools show you a number and leave you to guess where it
          came from.
        </h1>
        <p className="text-[13px] leading-relaxed text-mut">
          This one labels every figure with its source, its timestamp, and
          whether it was computed here, returned by a data provider, or
          generated by a model. When a provider has nothing for a company, it
          says so instead of showing a blank cell. When a number is an
          estimate, it says that too.
        </p>
        <p className="text-[13px] leading-relaxed text-mut mt-2">
          It is a research tool for Indian and global equities. You bring the
          questions; it does the arithmetic and shows its working.
        </p>

        <div className="flex items-center gap-3 mt-6">
          <Link href="/login" className="btn-primary text-[12px] px-4">
            Sign in
          </Link>
          <Link href="/disclosures"
                className="btn-ghost text-[11px] px-3">
            Read the disclosures
          </Link>
        </div>
      </header>

      <Section id="does" heading="What it does">
        <dl className="flex flex-col gap-3 not-prose">
          {WHAT_IT_DOES.map((f) => (
            <div key={f.name}>
              <dt className="text-txt/90 text-[12.5px] font-medium">{f.name}</dt>
              <dd className="mt-0.5">{f.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="data" heading="Where the numbers come from">
        <p>{DATA_HONESTY}</p>
        <p>
          That paragraph is the product. Every tool here will happily compute a
          ratio from a figure a provider got wrong, and the only defence is
          knowing which figure came from where — so the app tells you, on every
          screen, rather than burying it in a methodology page.
        </p>
      </Section>

      <Section id="money" heading="How it makes money">
        <p>{CONFLICTS}</p>
      </Section>

      <Section id="not" heading="What this is not">
        <p className="text-txt/90">{REGISTRATION_STATUS}</p>
        <ul className="list-disc pl-5 flex flex-col gap-1">
          {WHAT_THIS_IS_NOT.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p>
          Anything here that reads like a conclusion — a screen result, a
          backtest, a machine-written summary — is the output of a calculation
          over data you can inspect, not an analyst&apos;s opinion. Decisions
          you take after reading it are yours.
        </p>
      </Section>

      <footer className="border-t border-line pt-4 text-[11.5px] leading-relaxed text-mut">
        <p>{MARKET_RISK}</p>
        <p className="mt-2">
          Derivatives are leveraged: losses can exceed the amount you put in,
          and most individual traders in index derivatives lose money.
        </p>
        <p className="mt-3">
          <Link href="/disclosures" className="hover:text-amber underline">
            Disclosures
          </Link>
          <span className="mx-2">·</span>
          <Link href="/privacy" className="hover:text-amber underline">
            Privacy
          </Link>
          <span className="mx-2">·</span>
          <Link href="/terms" className="hover:text-amber underline">
            Terms
          </Link>
        </p>
      </footer>
    </div>
  );
}
