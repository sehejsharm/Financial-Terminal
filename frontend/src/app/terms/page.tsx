import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  openGraph: { url: "/terms" },
  robots: { index: true, follow: true },
};

// NOTE FOR THE OPERATOR (not shown to users): accurate to how the app works,
// but have a legal professional review it for your jurisdiction and set a real
// contact address and governing-law choice before launch.

const UPDATED = "4 September 2026";
const CONTACT = "support@your-domain.example"; // TODO: replace with a real address

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 leading-relaxed text-txt/90">{children}</p>;
}
function H({ children }: { children: React.ReactNode }) {
  return <h2 className="text-amber font-semibold mt-7 mb-2 text-[15px]">{children}</h2>;
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-bg text-txt">
      <div className="max-w-2xl mx-auto px-5 py-10 text-[13.5px]">
        <Link href="/" className="text-amber text-sm">← Motherboard Terminal</Link>
        <h1 className="text-xl font-bold mt-4 mb-1">Terms of Service</h1>
        <div className="text-mut text-xs mb-6">Last updated: {UPDATED}</div>

        <P>
          By using Motherboard Terminal (“the app”) you agree to these terms. If
          you do not agree, do not use the app.
        </P>

        <H>What the app is</H>
        <P>
          The app is an educational and research tool for exploring equity
          markets. It shows market data, fundamentals, screeners, charts,
          portfolio and practice-portfolio analytics, alerts, and
          AI-generated summaries.
        </P>

        <H>Not investment advice</H>
        <P>
          Nothing in the app is investment, financial, legal, or tax advice, and
          nothing in it is a recommendation or solicitation to buy or sell any
          security. The app does not provide personalised advice or portfolio
          management. Investments in the securities market are subject to market
          risks; read all related documents carefully before investing. You are
          solely responsible for your own decisions.
        </P>

        <H>Data may be delayed or wrong</H>
        <P>
          Market data comes from third-party free providers and may be delayed,
          incomplete, or inaccurate. AI-generated text can be wrong. Figures in
          the app must be verified against a primary source before you rely on
          them. The app is provided “as is”, without warranties of accuracy,
          availability, or fitness for a particular purpose.
        </P>

        <H>Practice portfolios</H>
        <P>
          Practice (paper-trading) features use virtual money and simulated
          fills at delayed prices for education only. They do not represent real
          trades, real orders, or real returns.
        </P>

        <H>Your account</H>
        <P>
          You are responsible for keeping your credentials secure and for
          activity under your account. Do not attempt to access other users’
          data, disrupt the service, or scrape it in a way that breaches the
          third-party providers’ terms.
        </P>

        <H>Limitation of liability</H>
        <P>
          To the maximum extent permitted by law, the app and its operators are
          not liable for any loss or damage arising from your use of the app or
          from reliance on any data or content it presents, including trading or
          investment losses.
        </P>

        <H>Changes and termination</H>
        <P>
          These terms may change; the “last updated” date will reflect that.
          Access may be suspended or terminated for misuse.
        </P>

        <H>Contact</H>
        <P>
          Questions: <span className="text-amber">{CONTACT}</span>.
        </P>

        <div className="mt-8 text-xs text-mut">
          See also our <Link href="/privacy" className="text-amber underline">Privacy Policy</Link>.
        </div>
      </div>
    </div>
  );
}
