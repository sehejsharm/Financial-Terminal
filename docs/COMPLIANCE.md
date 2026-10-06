# Compliance register

What is implemented, and what is still a question for a lawyer.

**Read this first: I am not qualified to give legal advice, and nothing in this
file is a legal opinion.** It is an engineer's record of what the software now
does, written so that whoever does advise you can see the current state without
reading the codebase. Everything in §1 needs confirming before launch.

---

## 1. Open — needs a qualified opinion before launch

### 1.1 Are we a Research Analyst or an Investment Adviser under SEBI? (BLOCKING)

This is the one question that determines whether registration is mandatory,
and it cannot be answered from the code.

The argument that we are **not**: the product displays data, runs filters the
user defines, and computes statistics over prices. It makes no recommendation,
gives no personalised advice, manages no money and executes no trades.

The argument that we **might be**: the AI panel generates prose that reads like
a research note — a bull case, a bear case, a scenario — about a named,
tradeable security, on demand. Whether machine-generated commentary on a
specific stock constitutes a "research report", and whether offering it for a
subscription fee constitutes holding oneself out as a research analyst, is
exactly the kind of question where my reading is worth nothing.

**Current software position:** the app states it is **not registered** with
SEBI as a Research Analyst or Investment Adviser, on `/disclosures` and in the
app-wide footer. That is the conservative direction: understating credentials
we may have is survivable, while holding ourselves out as a registered
intermediary when we are not is an offence. **If registration has been obtained
or is obtained later, both of those statements must be updated** — grep for
"not registered with SEBI".

**If the answer is that registration IS required,** the AI panel is the surface
to re-examine first. Gating it, removing it, or restricting it to
non-security-specific output are all cheaper than registration.

### 1.2 Advertising and the marketing site (Phase 9)

If §1.1 lands on "registered", the SEBI advertising code constrains what the
marketing site may claim — performance figures, testimonials and comparative
claims in particular. Phase 9 should not be written until §1.1 is settled.

### 1.3 Terms and privacy policy have not been reviewed by a lawyer

`/terms` and `/privacy` were written as engineering documents. They have not
been reviewed, and in particular:

- The DPDP Act 2023 obligations (consent notice, grievance officer, breach
  notification, data principal rights, retention limits) are not systematically
  mapped. The grievance channel in §2.4 is a starting point, not compliance.
- Liability limitation and the governing-law clause need checking against
  Indian consumer law, which limits how far they can go.

### 1.4 Pricing and tax

₹499/month is a placeholder. GST registration and whether the price is shown
inclusive or exclusive are unresolved, and the billing surfaces will need
invoice fields (GSTIN, place of supply, HSN/SAC) once a payment provider is
wired up.

---

## 2. Implemented

### 2.1 Market risk disclaimer — app-wide

SEBI's wording, verbatim and unparaphrased: *"Investments in securities market
are subject to market risks. Read all the related documents carefully before
investing."*

Rendered from the shell (`components/Disclaimer.tsx`), not per page, so no
screen can be missing it.

### 2.2 Registration status — app-wide footer and `/disclosures`

See §1.1. Also states what the product is not: no personalised advice, no
recommendations, no portfolio management, no solicitation.

### 2.3 Per-surface risk notices

A footer at the bottom of a page does not attach to a chart in the middle of
it. The three surfaces that produce output *looking like* a conclusion each
carry their own caveat:

| Surface | What it says | Where |
|---|---|---|
| AI panel | Machine-generated, not research, not reviewed by an analyst, models state things confidently whether or not they are correct | `RiskNotice variant="ai"`, attached to the **output** |
| Backtester | Fitted to this window; includes the required *"Past performance is not indicative of future results"* | existing footnote |
| Option builder | Leveraged; can lose more than the margin put up; a long option can expire worthless; most individual traders in index derivatives lose money | existing footnote |

Two notes on how this was done:

- **The caveat follows copied AI text.** The panel has a "Copy markdown"
  button, so output leaves the app entirely — pasted into a chat or a group
  where no on-screen context follows it. The clipboard payload now carries a
  short disclaimer, because machine-written prose about a named stock
  circulating with no indication of what wrote it is the most misleading thing
  this product can emit.
- **The AI caveat used to appear only before you asked for anything** and
  vanished the moment there was output to caveat. It is now attached to the
  output.

### 2.4 Grievance mechanism

`/disclosures` carries a complaint form and a monitored address. A complaint:

- returns a **reference number** the user can keep,
- is **written to disk before** the acknowledgement is emailed — so a mail
  outage cannot lose a complaint the user holds a reference for,
- is acknowledged by email, with the escalation route named in the message,
- states a **7 working day** response commitment,
- names **SEBI SCORES** (`scores.sebi.gov.in`) as the escalation path, and says
  explicitly that escalating needs no permission from us and will not be
  treated as grounds to close an account.

Unauthenticated on purpose: the people most likely to need it are the ones who
cannot sign in. Rate-limited to 5/min since it is public, writes to disk and
sends mail.

**Not implemented:** no SLA timer, no admin queue, no reminder when a complaint
ages past 7 days. Complaints land in `data/grievances.json` and the
acknowledgement email. Somebody has to actually read them, and nothing in the
software enforces that.

### 2.5 Data provenance and its limits

`/disclosures` names every source (NSE's public site, Twelve Data, FMP, Yahoo
Finance, XBRL filings, FRED) and states plainly that **none of it is a licensed
real-time feed**, which is why prices are labelled "Public data" rather than
"live". It also states the specific ways the data is wrong: mis-mapped tickers
after corporate actions, silent restatements, missing data for thin names
(which excludes them from screens rather than flagging them), and bugs in our
own normalisation of filings.

Enforced in code, not just claimed: see `docs/DATA-PLANE.md`. We never label
public data "real-time", never state a delay we did not apply, and mark a
timestamp as estimated when it is our clock rather than the provider's.

### 2.6 Conflicts of interest

Stated on `/disclosures`: subscription revenue only; no payment from any
issuer, broker, exchange, asset manager or distributor; no commission, no
brokerage, no advertising; nobody can pay to appear, rank higher or be excluded
from a screen. **This is a factual claim about the business — if any of it
stops being true, that page is the first thing to change.**

---

## 3. Configuration

| Variable | Why it matters |
|---|---|
| `NEXT_PUBLIC_GRIEVANCE_EMAIL` | Printed on `/disclosures` as the complaint address and used in the fallback message when the form fails. It defaults to a `.invalid` address, which **must** be replaced before launch — an unreachable grievance address is worse than none, because the page claims it is monitored. |
| `MAIL_PROVIDER` / `RESEND_API_KEY` | Complaint acknowledgements go out through the same mailer as invites. On `console` the acknowledgement is logged and never sent; the complaint is still recorded. |
