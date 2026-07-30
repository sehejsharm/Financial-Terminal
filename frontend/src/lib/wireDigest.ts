/** What the wire is actually saying.
 *
 *  The market tab pulled 120 headlines, deduplicated them, clustered the
 *  syndicated copies and rendered a list. Everything there is good, and it
 *  still leaves the reader doing the only job that matters: scanning a hundred
 *  and twenty lines to work out what today is about.
 *
 *  A wire is consulted for three things — which companies are in the news,
 *  what the recurring subject is, and whether the feed is healthy enough that
 *  a quiet page means a quiet market. None of the three were answered.
 *
 *  The company tagging is deliberately a FIXED list. Guessing a company from
 *  free text is how the terminal ended up showing Reliance Steel news under
 *  RELIANCE.NS, and a wrong tag on a wire is worse than no tag: it sends
 *  someone to the wrong screen. So it matches known names and aliases only,
 *  and the note says exactly how far the list reaches.
 */

export type Item = {
  title: string;
  publisher?: string;
  link?: string;
  summary?: string;
  published?: string | null;
  source?: string | null;
};

/** A listed company the wire can recognise, with the ways it gets written. */
type Entry = { ticker: string; name: string; aliases: readonly string[] };

/**
 * NIFTY 50 plus the handful of names the Indian wires mention constantly.
 *
 * Aliases matter more than the formal name: nobody writes "Housing Development
 * Finance Corporation Bank" in a headline, they write "HDFC Bank". Single
 * ambiguous words ("Tata", "Adani", "Bajaj") are deliberately NOT aliases —
 * they name a group with several listed companies, and tagging a group story
 * to one of them is a fabrication.
 */
export const UNIVERSE: readonly Entry[] = [
  { ticker: "RELIANCE.NS", name: "Reliance Industries", aliases: ["reliance industries", "ril", "reliance jio", "jio", "reliance retail"] },
  { ticker: "TCS.NS", name: "Tata Consultancy Services", aliases: ["tata consultancy", "tcs"] },
  { ticker: "HDFCBANK.NS", name: "HDFC Bank", aliases: ["hdfc bank"] },
  { ticker: "ICICIBANK.NS", name: "ICICI Bank", aliases: ["icici bank", "icici"] },
  { ticker: "INFY.NS", name: "Infosys", aliases: ["infosys"] },
  { ticker: "HINDUNILVR.NS", name: "Hindustan Unilever", aliases: ["hindustan unilever", "hul"] },
  { ticker: "ITC.NS", name: "ITC", aliases: ["itc ltd", "itc limited"] },
  { ticker: "SBIN.NS", name: "State Bank of India", aliases: ["state bank of india", "sbi"] },
  { ticker: "BHARTIARTL.NS", name: "Bharti Airtel", aliases: ["bharti airtel", "airtel", "bharti"] },
  { ticker: "KOTAKBANK.NS", name: "Kotak Mahindra Bank", aliases: ["kotak mahindra", "kotak bank"] },
  { ticker: "LT.NS", name: "Larsen & Toubro", aliases: ["larsen & toubro", "larsen and toubro", "l&t"] },
  { ticker: "BAJFINANCE.NS", name: "Bajaj Finance", aliases: ["bajaj finance"] },
  { ticker: "AXISBANK.NS", name: "Axis Bank", aliases: ["axis bank"] },
  { ticker: "ASIANPAINT.NS", name: "Asian Paints", aliases: ["asian paints"] },
  { ticker: "MARUTI.NS", name: "Maruti Suzuki", aliases: ["maruti suzuki", "maruti"] },
  { ticker: "HCLTECH.NS", name: "HCL Technologies", aliases: ["hcl technologies", "hcltech", "hcl tech"] },
  { ticker: "SUNPHARMA.NS", name: "Sun Pharmaceutical", aliases: ["sun pharma", "sun pharmaceutical"] },
  { ticker: "TITAN.NS", name: "Titan Company", aliases: ["titan company"] },
  { ticker: "ULTRACEMCO.NS", name: "UltraTech Cement", aliases: ["ultratech"] },
  { ticker: "WIPRO.NS", name: "Wipro", aliases: ["wipro"] },
  { ticker: "NESTLEIND.NS", name: "Nestlé India", aliases: ["nestle india", "nestlé india"] },
  { ticker: "ONGC.NS", name: "Oil and Natural Gas Corporation", aliases: ["ongc", "oil and natural gas"] },
  { ticker: "NTPC.NS", name: "NTPC", aliases: ["ntpc"] },
  { ticker: "POWERGRID.NS", name: "Power Grid Corporation", aliases: ["power grid corporation", "powergrid"] },
  { ticker: "M&M.NS", name: "Mahindra & Mahindra", aliases: ["mahindra & mahindra", "mahindra and mahindra"] },
  { ticker: "TATAMOTORS.NS", name: "Tata Motors", aliases: ["tata motors"] },
  { ticker: "TATASTEEL.NS", name: "Tata Steel", aliases: ["tata steel"] },
  { ticker: "JSWSTEEL.NS", name: "JSW Steel", aliases: ["jsw steel"] },
  { ticker: "ADANIENT.NS", name: "Adani Enterprises", aliases: ["adani enterprises"] },
  { ticker: "ADANIPORTS.NS", name: "Adani Ports", aliases: ["adani ports"] },
  { ticker: "COALINDIA.NS", name: "Coal India", aliases: ["coal india"] },
  { ticker: "BAJAJFINSV.NS", name: "Bajaj Finserv", aliases: ["bajaj finserv"] },
  { ticker: "GRASIM.NS", name: "Grasim Industries", aliases: ["grasim"] },
  { ticker: "HINDALCO.NS", name: "Hindalco Industries", aliases: ["hindalco"] },
  { ticker: "BRITANNIA.NS", name: "Britannia Industries", aliases: ["britannia"] },
  { ticker: "CIPLA.NS", name: "Cipla", aliases: ["cipla"] },
  { ticker: "DRREDDY.NS", name: "Dr Reddy's Laboratories", aliases: ["dr reddy", "dr. reddy", "dr reddy's"] },
  { ticker: "EICHERMOT.NS", name: "Eicher Motors", aliases: ["eicher motors", "royal enfield"] },
  { ticker: "HEROMOTOCO.NS", name: "Hero MotoCorp", aliases: ["hero motocorp"] },
  { ticker: "BPCL.NS", name: "Bharat Petroleum", aliases: ["bharat petroleum", "bpcl"] },
  { ticker: "TATACONSUM.NS", name: "Tata Consumer Products", aliases: ["tata consumer"] },
  { ticker: "APOLLOHOSP.NS", name: "Apollo Hospitals", aliases: ["apollo hospitals"] },
  { ticker: "INDUSINDBK.NS", name: "IndusInd Bank", aliases: ["indusind"] },
  { ticker: "BAJAJ-AUTO.NS", name: "Bajaj Auto", aliases: ["bajaj auto"] },
  { ticker: "SBILIFE.NS", name: "SBI Life Insurance", aliases: ["sbi life"] },
  { ticker: "HDFCLIFE.NS", name: "HDFC Life Insurance", aliases: ["hdfc life"] },
  { ticker: "TECHM.NS", name: "Tech Mahindra", aliases: ["tech mahindra"] },
  { ticker: "LTIM.NS", name: "LTIMindtree", aliases: ["ltimindtree", "mindtree"] },
  { ticker: "SHRIRAMFIN.NS", name: "Shriram Finance", aliases: ["shriram finance"] },
  { ticker: "TRENT.NS", name: "Trent", aliases: ["trent ltd", "westside"] },
  { ticker: "DMART.NS", name: "Avenue Supermarts", aliases: ["dmart", "d-mart", "avenue supermarts"] },
  { ticker: "ZOMATO.NS", name: "Eternal (Zomato)", aliases: ["zomato", "eternal ltd"] },
  { ticker: "PAYTM.NS", name: "One97 Communications", aliases: ["paytm", "one97"] },
  { ticker: "VEDL.NS", name: "Vedanta", aliases: ["vedanta"] },
  { ticker: "IRCTC.NS", name: "IRCTC", aliases: ["irctc"] },
  { ticker: "YESBANK.NS", name: "Yes Bank", aliases: ["yes bank"] },
  { ticker: "IDEA.NS", name: "Vodafone Idea", aliases: ["vodafone idea", "vi "] },
  { ticker: "SUZLON.NS", name: "Suzlon Energy", aliases: ["suzlon"] },
];

/** Lower-cased, punctuation flattened, so "Dr. Reddy's" and "Dr Reddys"
 *  are the same string to match against. */
export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9&]+/g, " ").trim()} `;
}

function aliasPattern(alias: string): string {
  return ` ${alias.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9&]+/g, " ").trim()} `;
}

export type Mention = {
  ticker: string;
  name: string;
  count: number;
  /** The most recent headline naming it, for the link out. */
  headline: string;
  link: string | null;
};

/**
 * Which listed companies the wire is writing about.
 *
 * Matching is on whole words only — a substring rule tags "Titan" inside
 * "titanium" and "Vi" inside "vision", and the resulting list is worse than
 * nothing because every entry has to be double-checked.
 */
export function mentions(items: Item[], universe: readonly Entry[] = UNIVERSE): Mention[] {
  const hits = new Map<string, Mention>();
  for (const it of items) {
    const hay = normalize(`${it.title ?? ""} ${it.summary ?? ""}`);
    for (const e of universe) {
      const matched = e.aliases.some((a) => hay.includes(aliasPattern(a)))
        || hay.includes(aliasPattern(e.name));
      if (!matched) continue;
      const prev = hits.get(e.ticker);
      if (prev) {
        prev.count += 1;
      } else {
        hits.set(e.ticker, {
          ticker: e.ticker, name: e.name, count: 1,
          headline: it.title, link: it.link ?? null,
        });
      }
    }
  }
  return [...hits.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── what the day is about ─────────────────────────────────────────────────

/** Words that carry no subject. Deliberately long: a "theme" list topped by
 *  "says", "after" and "amid" is noise wearing a heading. */
const STOP = new Set(`a an the and or but if then than that this these those of in on at to for
  with from by as is are was were be been being it its it's he she they them their our your my
  i you we us not no nor so such can could will would shall should may might must do does did
  done have has had having about after before during over under up down out off again further
  more most other some any each few own same too very just now new news top best worst big
  says say said report reports reported see sees seen get gets got make makes made take takes
  taken go goes going come comes what which who whom when where why how all also into amid vs
  latest update updates live today day week month year first second last next here there
  full read watch photos video`.split(/\s+/));

export type Theme = {
  phrase: string;
  count: number;
  /** One headline containing it, so the theme is checkable. */
  example: string;
  link: string | null;
};

/**
 * The recurring subjects, as two-word phrases.
 *
 * Single words are too blunt — "rate" appears in rate cut, rate hike and
 * exchange rate, which are three different days. Two words ("rate cut", "block
 * deal", "q1 results") name a subject. Longer n-grams are more precise and far
 * too sparse across a hundred headlines to recur at all.
 *
 * Counted once per STORY, not once per occurrence, so a wire that syndicates
 * one piece twenty times doesn't manufacture a theme out of it.
 */
export function themes(items: Item[], minCount = 3, limit = 8): Theme[] {
  const counts = new Map<string, { n: number; example: string; link: string | null }>();
  for (const it of items) {
    const words = normalize(it.title ?? "").trim().split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
    const seen = new Set<string>();
    for (let i = 0; i + 1 < words.length; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (seen.has(phrase)) continue;   // once per headline
      seen.add(phrase);
      const prev = counts.get(phrase);
      if (prev) prev.n += 1;
      else counts.set(phrase, { n: 1, example: it.title, link: it.link ?? null });
    }
  }
  return [...counts.entries()]
    .filter(([, v]) => v.n >= minCount)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([phrase, v]) => ({ phrase, count: v.n, example: v.example, link: v.link }));
}

// ── is the wire healthy ───────────────────────────────────────────────────

export type FeedHealth = {
  sources: { name: string; n: number }[];
  total: number;
  /** Feeds that delivered nothing this pull. */
  silent: string[];
  /** Share of items from the single largest source, 0–100. */
  topSharePct: number | null;
};

/** Every feed the backend is configured to pull, so a silent one is visible.
 *  A wire that looks quiet because three sources are down reads exactly like
 *  a quiet market, and only this distinguishes them. */
export const CONFIGURED_FEEDS = [
  "Economic Times", "Business Standard", "Livemint", "Moneycontrol",
  "BusinessLine", "Yahoo Finance", "CNBC", "Reuters", "Google News",
] as const;

export function feedHealth(items: Item[],
                           configured: readonly string[] = CONFIGURED_FEEDS): FeedHealth {
  const counts = new Map<string, number>();
  for (const it of items) {
    const s = (it.source || it.publisher || "").trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sources = [...counts.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n);
  const total = items.length;
  const seen = new Set([...counts.keys()].map((s) => s.toLowerCase()));
  return {
    sources,
    total,
    // Substring either way: the feed is configured as "CNBC" and items arrive
    // labelled "CNBC-TV18".
    silent: configured.filter((f) =>
      ![...seen].some((s) => s.includes(f.toLowerCase()) || f.toLowerCase().includes(s))),
    topSharePct: total > 0 && sources.length ? (sources[0].n / total) * 100 : null,
  };
}

export function digestNote(m: Mention[], t: Theme[], h: FeedHealth): string {
  const parts: string[] = [];

  parts.push(m.length
    ? `${m.length} listed companies were recognised across ${h.total} headlines. `
      + "Tagging is against a FIXED list of the NIFTY 50 and a few frequently "
      + "written-about names, matched on whole words and known aliases only — "
      + "so a company outside that list is simply not tagged, and the counts "
      + "are a floor rather than a census."
    : `No company from the recognised list appears in these ${h.total} headlines. `
      + "The list covers the NIFTY 50 and a few others, so this means those "
      + "names are quiet rather than that nothing is happening.");

  parts.push("Group words like “Tata” and “Adani” are deliberately not matched "
    + "on their own: they name several listed companies, and pinning a group "
    + "story to one of them would be a fabrication of exactly the kind the "
    + "per-ticker feed already had to fix.");

  if (t.length) {
    parts.push("Themes are two-word phrases counted once per story, so a piece "
      + "syndicated twenty times cannot manufacture one. They describe what is "
      + "being WRITTEN about, which is not the same as what matters.");
  }

  if (h.silent.length) {
    parts.push(`${h.silent.length} configured feed${h.silent.length === 1 ? "" : "s"} `
      + `returned nothing this pull (${h.silent.join(", ")}). A quiet page with `
      + "feeds down looks identical to a quiet market, which is why this is "
      + "here.");
  }
  if (h.topSharePct != null && h.topSharePct > 50) {
    parts.push(`${h.sources[0].name} supplied ${h.topSharePct.toFixed(0)}% of `
      + "these headlines, so the wire currently reflects one outlet's editorial "
      + "priorities more than the market's.");
  }
  return parts.join(" ");
}
