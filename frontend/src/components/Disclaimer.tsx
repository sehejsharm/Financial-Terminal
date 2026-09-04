/** The market-risk disclaimer, shown on every page.
 *
 *  The first sentence is SEBI's mandated wording verbatim — any app surfacing
 *  Indian securities data is expected to carry it, and it must not be
 *  paraphrased. The second states plainly what this app is (educational, not
 *  advice), which is also what Google Play's financial-products policy wants to
 *  see. It renders app-wide from the shell rather than per page so no screen
 *  can ever be missing it.
 */
export function Disclaimer() {
  return (
    <footer className="mt-8 border-t border-line/60 pt-3 text-[11.5px] leading-relaxed text-mut">
      <p>
        Investments in securities market are subject to market risks. Read all
        the related documents carefully before investing.
      </p>
      <p className="mt-1">
        Motherboard Terminal is an educational and research tool. It does not
        provide personalised investment advice, recommendations, or portfolio
        management, and nothing shown here is a solicitation to buy or sell any
        security. Market data may be delayed, incomplete, or sourced from free
        providers, and figures can be wrong — verify against a primary source
        before acting.
      </p>
    </footer>
  );
}
