"use client";

/** Regulatory disclosures, data provenance, and how to complain.
 *
 *  Three things a user of an Indian markets product is entitled to find in one
 *  place and currently could not find at all: whether we are registered with
 *  SEBI, where the numbers come from and how wrong they can be, and what
 *  happens if they have a complaint.
 *
 *  THE REGISTRATION STATEMENT IS DELIBERATELY THE CONSERVATIVE ONE. It says we
 *  are NOT registered as a research analyst or investment adviser. If that is
 *  wrong because registration has since been obtained, it needs updating — but
 *  the failure mode of this direction is understating our own credentials,
 *  while the failure mode of the other direction is holding ourselves out as a
 *  registered intermediary when we are not, which is an offence. See
 *  docs/COMPLIANCE.md.
 */

import { useState } from "react";

import { api } from "@/lib/api";

const GRIEVANCE_EMAIL = process.env.NEXT_PUBLIC_GRIEVANCE_EMAIL
  || "support@motherboard.invalid";

function Section({ title, children }: {
  title: string; children: React.ReactNode;
}) {
  return (
    <section className="mb-7">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <div className="text-[12.5px] leading-relaxed text-mut flex flex-col gap-2">
        {children}
      </div>
    </section>
  );
}

function GrievanceForm() {
  const [body, setBody] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.fileGrievance(body, email);
      setSent(r.reference);
    } catch {
      // A complaint channel that can silently fail is not a complaint
      // channel. If the form breaks, the email address has to still work.
      setError(
        `Could not file this. Email ${GRIEVANCE_EMAIL} directly — that `
        + "address is monitored and does not depend on this form.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="panel-2 p-3 text-[12px] leading-relaxed">
        Filed. Your reference is{" "}
        <span className="text-amber font-mono">{sent}</span> — keep it. We will
        reply within 7 working days. If we do not, or you are not satisfied
        with the reply, escalate to SEBI SCORES (below).
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel-2 p-3 flex flex-col gap-2">
      <label className="label-xs" htmlFor="gr-email">
        Your email (so we can reply)
      </label>
      <input
        id="gr-email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="input-bare"
      />
      <label className="label-xs mt-1" htmlFor="gr-body">
        What went wrong
      </label>
      <textarea
        id="gr-body"
        required
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="input-bare resize-y"
      />
      <button disabled={busy} className="btn-primary mt-1 text-[11px] disabled:opacity-60">
        {busy ? "Filing…" : "File a complaint"}
      </button>
      {error && <div className="text-red text-[11px]">{error}</div>}
    </form>
  );
}

export default function DisclosuresPage() {
  return (
    <div className="min-h-dvh max-w-2xl mx-auto px-5 py-10">
      <a href="/" className="label-xs hover:text-amber">← Motherboard Terminal</a>
      <h1 className="text-lg font-semibold mt-3 mb-6">Disclosures</h1>

      <Section title="Regulatory status">
        <p className="text-txt/90">
          Motherboard Terminal is <strong>not registered with SEBI</strong> as a
          Research Analyst or as an Investment Adviser, and is not a stock
          broker, portfolio manager or distributor of any financial product.
        </p>
        <p>
          It is a research and analysis tool. It does not provide personalised
          investment advice, does not make recommendations to buy or sell any
          security, does not manage money, and does not execute trades. Nothing
          on it is a solicitation or an offer.
        </p>
        <p>
          Anything on this site that reads like a conclusion — a
          machine-written summary, a screen result, a backtest — is output from
          a calculation over data you can see, not an analyst&apos;s opinion.
          Decisions you take after reading it are yours.
        </p>
      </Section>

      <Section title="Market risk">
        <p className="text-txt/90">
          Investments in securities market are subject to market risks. Read
          all the related documents carefully before investing.
        </p>
        <p>
          Derivatives are leveraged: losses can exceed the amount you put in,
          and most individual traders in index derivatives lose money.
        </p>
      </Section>

      <Section title="Where the data comes from, and how wrong it can be">
        <p>
          Prices, fundamentals and corporate data are sourced from the National
          Stock Exchange&apos;s public website, Twelve Data, Financial
          Modeling Prep and Yahoo Finance, and from company filings published
          as XBRL. Macroeconomic series come from FRED.
        </p>
        <p>
          <strong className="text-txt/90">None of this is a licensed
          real-time feed.</strong> It is public data whose lag we do not
          control and cannot state precisely, which is why prices are labelled
          &ldquo;Public data&rdquo; rather than &ldquo;live&rdquo;. Every quote
          carries the timestamp the provider gave us, where it gave one.
        </p>
        <p>
          Figures can be wrong. Providers mis-map tickers after corporate
          actions, restate history without notice, and return nothing at all
          for thinly traded names — which silently excludes them from screens
          rather than flagging them. Reported financials are normalised from
          filings by code, and that normalisation has bugs. Verify anything you
          would act on against the company&apos;s own filing or your
          broker&apos;s terminal.
        </p>
      </Section>

      <Section title="Conflicts of interest">
        <p>
          Motherboard Terminal earns money from subscriptions only. It is not
          paid by any issuer, broker, exchange, asset manager or distributor,
          takes no commission or brokerage, and runs no advertising. No company
          can pay to appear, rank higher, or be excluded from a screen.
        </p>
        <p>
          Screens and rankings are ordered by the criteria you set, applied to
          the data as received. There is no editorial list.
        </p>
      </Section>

      <Section title="If you have a complaint">
        <p>
          Email{" "}
          <a href={`mailto:${GRIEVANCE_EMAIL}`} className="text-amber underline">
            {GRIEVANCE_EMAIL}
          </a>{" "}
          or use the form below. You will get a reference number and a reply
          within 7 working days.
        </p>
        <GrievanceForm />
        <p className="mt-2">
          If we do not reply, or you are not satisfied with the reply, you can
          escalate to SEBI through the SCORES platform at{" "}
          <a
            href="https://scores.sebi.gov.in"
            target="_blank"
            rel="noreferrer noopener"
            className="text-amber underline"
          >
            scores.sebi.gov.in
          </a>
          , or to the relevant consumer forum. Escalating does not require our
          permission and we will not treat it as a reason to close your
          account.
        </p>
      </Section>

      <Section title="Terms and privacy">
        <p>
          <a href="/terms" className="text-amber underline">Terms of use</a>
          <span className="mx-2">·</span>
          <a href="/privacy" className="text-amber underline">Privacy policy</a>
        </p>
      </Section>
    </div>
  );
}
