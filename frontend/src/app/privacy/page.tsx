import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  openGraph: { url: "/privacy" },
  robots: { index: true, follow: true },
};

// NOTE FOR THE OPERATOR (not shown to users): this policy is written to match
// what the code actually does today. Before launch, (1) set a real contact
// address in place of the placeholder below, (2) confirm the effective date,
// and (3) have it reviewed by a legal professional for your jurisdiction —
// this is accurate but is not a substitute for that review.

const UPDATED = "4 September 2026";
const CONTACT = "privacy@your-domain.example"; // TODO: replace with a real address

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 leading-relaxed text-txt/90">{children}</p>;
}
function H({ children }: { children: React.ReactNode }) {
  return <h2 className="text-amber font-semibold mt-7 mb-2 text-[15px]">{children}</h2>;
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-bg text-txt">
      <div className="max-w-2xl mx-auto px-5 py-10 text-[13.5px]">
        <Link href="/" className="text-amber text-sm">← Motherboard Terminal</Link>
        <h1 className="text-xl font-bold mt-4 mb-1">Privacy Policy</h1>
        <div className="text-mut text-xs mb-6">Last updated: {UPDATED}</div>

        <P>
          Motherboard Terminal (“the app”) is an educational markets-research
          tool. This policy explains what the app collects, why, and what it
          does not do. It is written to describe the app’s actual behaviour.
        </P>

        <H>What we collect</H>
        <P>
          <b>Account details.</b> When an account is created you provide a
          username and a password. Passwords are never stored in readable form —
          only a salted PBKDF2 hash is kept, which cannot be reversed to your
          password.
        </P>
        <P>
          <b>Passkeys (optional).</b> If you register a passkey, the app stores
          the public key and a signature counter for that credential. Your
          fingerprint, face, or device PIN never leaves your device and is never
          transmitted to or seen by the app.
        </P>
        <P>
          <b>Your content.</b> Notes, watchlists, portfolios (including
          practice/paper positions), price alerts, and saved workspaces you
          create are stored on the server against your account so they are there
          when you sign back in. They are visible only to your account.
        </P>
        <P>
          <b>On your device.</b> The app stores small preferences in your
          browser’s local storage — theme, colour-mode, home region, chart and
          layout settings, recently viewed tickers, and a short-lived cache of
          non-personal market data so pages load quickly on repeat visits. This
          stays on your device and is not sent to us.
        </P>
        <P>
          <b>Alert delivery (optional).</b> If you enable email, Telegram, or
          web-push alerts, the app stores the destination you provide (an email
          address, a Telegram chat link, or a browser push subscription) solely
          to deliver the alerts you set up.
        </P>
        <P>
          <b>Operational logs.</b> The server keeps limited request and audit
          logs (for example, admin actions and slow requests) to keep the
          service running and secure. These are not used to profile you.
        </P>

        <H>What we do NOT do</H>
        <P>
          We do not sell your personal data. We do not share it with advertisers
          or data brokers. The app runs no third-party advertising or
          cross-site tracking.
        </P>

        <H>Third-party market-data providers</H>
        <P>
          Prices, fundamentals, macro series, and AI-generated summaries come
          from third-party providers (which may include Yahoo Finance / yfinance,
          the National Stock Exchange of India, FRED, Financial Modeling Prep,
          Twelve Data, and Groq). When you view a ticker, the app requests that
          instrument’s public market data from these providers; it does not send
          them your account details, notes, or portfolio. Each provider has its
          own terms and privacy practices.
        </P>

        <H>Data retention and deletion</H>
        <P>
          Your content is kept while your account is active. You can delete
          individual notes, watchlists, positions, alerts, and passkeys from
          within the app at any time. To have your account and its data removed,
          contact us at the address below.
        </P>

        <H>Security</H>
        <P>
          Sessions use signed tokens with an expiry. Passwords are salted and
          hashed with PBKDF2, and passkeys use public-key cryptography where the
          private key stays in your device’s secure hardware. No system is
          perfectly secure, but access to your content is scoped to your account.
        </P>

        <H>Children</H>
        <P>
          The app is intended for users aged 13 and over and is not directed at
          children under 13.
        </P>

        <H>Changes</H>
        <P>
          If this policy changes, the “last updated” date above will change and,
          for material changes, the app will surface a notice.
        </P>

        <H>Contact</H>
        <P>
          Questions or deletion requests: <span className="text-amber">{CONTACT}</span>.
        </P>

        <div className="mt-8 text-xs text-mut">
          See also our <Link href="/terms" className="text-amber underline">Terms of Service</Link>.
        </div>
      </div>
    </div>
  );
}
