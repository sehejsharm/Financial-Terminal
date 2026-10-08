import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

const SITE_URL = "https://financial-terminal-peach.vercel.app";
// This is the text that shows under the title in search results, so it is
// marketing copy and has to be as true as anything on a page.
//
// It previously said "live NSE quotes ... free and in your browser". Both
// claims had stopped being true: prices come from public sources whose lag we
// do not control, which is exactly why the app labels them "Public data"
// rather than "live" (see backend/dataplane.py), and there is now a paid tier.
// Shipped meta descriptions are easy to forget precisely because nobody on the
// team ever reads them.
const DESCRIPTION =
  "A markets research terminal for Indian and global equities: fundamentals " +
  "parsed from filings, screeners, portfolio tracking, options analysis and " +
  "backtesting, with every figure labelled by where it came from.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Motherboard Terminal",
    template: "%s · Motherboard Terminal",
  },
  description: DESCRIPTION,
  // Pins the preferred URL. This host also answers on per-deployment preview
  // URLs, and nothing was telling a crawler which one is canonical.
  alternates: { canonical: "/" },
  // DEFAULT DENY. Every route in this app is "use client" behind an auth gate,
  // so the HTML a crawler gets is the app's chrome — nav labels and a tooltip.
  // Public pages opt back IN explicitly (/login, /privacy, /terms,
  // /disclosures, /product all set robots:{index:true}).
  //
  // This is the right instrument, and robots.txt Disallow is not: Disallow
  // blocks CRAWLING, not indexing. Any of these URLs already in the index —
  // they were crawlable and sitemapped until recently — could then never be
  // re-fetched, so Google would never see a removal signal and they would
  // linger as title-only results. A noindex has to be crawlable to be read.
  robots: { index: false, follow: false },
  applicationName: "Motherboard Terminal",
  manifest: "/manifest.json",
  // Standalone-mode hints. `mobile-web-app-capable` is the current standard
  // name; `apple-web-app` emits the iOS-specific pair Next knows about. Both
  // are what let an installed PWA/TWA drop the browser chrome.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Motherboard" },
  other: { "mobile-web-app-capable": "yes" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Motherboard Terminal",
    title: "Motherboard Terminal",
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Motherboard Terminal" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Motherboard Terminal",
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  // app/icon.png + app/apple-icon.png are picked up automatically by the App
  // Router; public/favicon.ico is the legacy fallback for old browsers.
};

export const viewport: Viewport = {
  themeColor: "#0c0e12",
  // Draw under notches and rounded corners in standalone mode; pages opt into
  // the safe area with env(safe-area-inset-*) padding where it matters.
  viewportFit: "cover",
};

// Applied before first paint so the persisted theme wins immediately —
// and so <html> never carries both "dark" and "light" at once (the old
// hardcoded className="dark" was never removed by the toggle).
const THEME_BOOT = `(function(){try{
  var l = localStorage.getItem("mb_theme") === "light";
  var c = document.documentElement.classList;
  c.toggle("light", l); c.toggle("dark", !l);
  if (localStorage.getItem("mb_cb") === "1") c.add("cb");
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <ServiceWorker />
        {children}
      </body>
    </html>
  );
}
