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
  manifest: "/manifest.json",
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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
