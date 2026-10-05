/** @type {import('next').NextConfig} */

// The API the browser talks to. It must appear in connect-src or every fetch,
// WebSocket and SSE connection is blocked — the whole app is client-fetched,
// so getting this wrong takes the product down rather than degrading it.
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const WS = API.replace(/^http/, "ws");

// SHA-256 of the inline theme-boot script in src/app/layout.tsx.
//
// A hash rather than a nonce: nonces must be generated per request, which
// forces every route to render dynamically and would throw away the static
// rendering the whole app currently gets. A hash keeps the routes static.
//
// IT IS TIED TO THE SCRIPT'S EXACT BYTES. Edit THEME_BOOT and this must be
// recomputed or the theme will flash on every load. The test in
// src/lib/__tests__/cspHash.test.ts fails if they drift apart.
const THEME_BOOT_SHA = "'sha256-EqHEssTVVFSJ6AXVPC/9kplpseZ6fscvaQfoHu0if/s='";

// Content-Security-Policy.
//
// Shipped in REPORT-ONLY, and it cannot be flipped to enforcing yet. That is a
// finding, not an oversight — measured, not assumed:
//
// Loading /login, /, /screeners, /quant, /portfolio and /terminal under
// report-only produced 42 violations. Every one is "Refused to execute inline
// script". The served HTML has 7 inline <script> tags: one is our theme-boot
// (hashed and allowed below) and SIX are Next's own RSC flight-data scripts —
// `self.__next_f.push([1,"0:[\"$\",\"$L2\"...` — whose contents differ per
// page and per build. There is no stable hash for them.
//
// So script-src on App Router has exactly three options:
//   1. 'unsafe-inline'  — enforceable today, but it defeats most of the point.
//   2. nonces           — requires middleware generating a per-request nonce,
//                         which forces every route to render dynamically and
//                         gives up the static rendering this app has. Next
//                         14.2.x also carries an advisory titled "cross-site
//                         scripting in App Router applications using CSP
//                         nonces", so this is not a safe move on this version.
//   3. report-only      — what ships here: zero risk of breaking the terminal,
//                         and every OTHER directive below is fully enforced.
//
// Option 2 becomes reasonable after the Next 16 upgrade. Until then, flipping
// CSP_ENFORCE=1 WILL break hydration — do not set it without re-running the
// violation check.
//
// There is no CDN, no Google Fonts, no TradingView and no next/font in this
// app — every asset is self-hosted — so the rest of the policy is tight.
const csp = [
  "default-src 'self'",
  `script-src 'self' ${THEME_BOOT_SHA}`,
  // 'unsafe-inline' for styles only. Next injects critical CSS as inline
  // <style> during hydration and there is no hash available for it. Inline
  // STYLE is a far smaller surface than inline script: it cannot execute.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${API} ${WS}`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Belt and braces with X-Frame-Options: frame-ancestors is the modern one
  // and the only one that accepts a source list.
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  {
    key: process.env.CSP_ENFORCE === "1"
      ? "Content-Security-Policy"
      : "Content-Security-Policy-Report-Only",
    value: csp,
  },
  // Two years, subdomains included, preload-eligible. Only meaningful over
  // HTTPS; browsers ignore it on http://localhost, so it is safe in dev.
  { key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny the hardware APIs outright — a markets terminal has no business
  // asking for any of them, so a request for one is a sign something is wrong.
  { key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
         + "magnetometer=(), gyroscope=(), accelerometer=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig = {
  reactStrictMode: true,
  // Hide the framework and version from every response. It is not a
  // vulnerability on its own; it just saves an attacker the lookup.
  poweredByHeader: false,
  // The backend is a separate service (Render/Fly). Vercel doesn't run the
  // FastAPI app — set NEXT_PUBLIC_API_URL in Vercel Project Settings → Env.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
