import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";

const SITE_URL = "https://financial-terminal-peach.vercel.app";
const DESCRIPTION =
  "Bloomberg-style markets terminal for Indian + global equities: live NSE quotes, " +
  "fundamental screeners, AI value-chain maps, portfolio P&L, price alerts, and " +
  "quant analytics — free and in your browser.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Motherboard Terminal",
    template: "%s · Motherboard Terminal",
  },
  description: DESCRIPTION,
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
      <body>{children}</body>
    </html>
  );
}
