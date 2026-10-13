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
// A FOURTH OPTION WAS PROPOSED AND IS NOW RULED OUT, MEASURED.
//
// docs/OPEN-ITEMS.md §G claimed enforcement did not need Next 16: "the pages
// are statically prerendered, so the `__next_f` inline scripts are fixed at
// build time and CAN be hashed by a post-build step (~46 hashes)". It sounds
// right. It is wrong, and scripts/csp-hashes.mjs is the measurement.
//
// Two CLEAN BUILDS OF IDENTICAL SOURCE each produced 23 prerendered HTML files
// with 68 distinct inline scripts — and the two hash sets largely DO NOT
// MATCH. Roughly half the hashes changed between builds with not a line of
// source edited. The flight-data payloads embed per-build chunk identifiers,
// so "fixed at build time" is true only of the build that produced them.
//
// That kills the approach rather than complicating it: a hash list is valid
// for exactly one build, and every deploy is a fresh build. Shipping it would
// mean a policy that is correct the day it is generated and silently blocks
// the app's own hydration on the next deploy — the worst failure shape
// available, because it looks like it is working.
//
// Re-check it in one command after the Next 16 upgrade:
//     npm run build && node scripts/csp-hashes.mjs --json > /tmp/a.json
//     rm -rf .next && npm run build && node scripts/csp-hashes.mjs --json > /tmp/b.json
//     diff /tmp/a.json /tmp/b.json
//
// AND THE REPORT-ONLY POSTURE NOW ACTUALLY REPORTS.
//
// It did not. There was no `report-uri` and no `report-to` anywhere, so every
// violation went to the console of whoever had devtools open and nowhere else.
// Report-only with no collector is not a weaker control than enforcement — it
// is not a control, while still looking like one. backend/routes/csp.py
// aggregates them, and GET /api/v1/csp-report/summary (master-admin) is the
// list that decides when CSP_ENFORCE is safe: flip it when every signature
// there is one that has since been hashed or allowed.
//
// There is no CDN, no Google Fonts, no TradingView and no next/font in this
// app — every asset is self-hosted — so the rest of the policy is tight.

// Where violations are posted. On the API origin, not this one: `report-uri`
// is exempt from CORS by design (the browser fires it and ignores the
// response), so a cross-origin collector needs no preflight and no rewrite —
// and routing it through Vercel would bill a function invocation per
// violation, which is precisely backwards for something that spikes when
// something is broken.
const CSP_REPORT_URI = `${API}/api/v1/csp-report`;

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
  // BOTH spellings, deliberately. `report-uri` is deprecated and is also the
  // only one Safari honours and the only one older Chrome honours; `report-to`
  // is the replacement and is what current Chrome prefers. Sending one would
  // silently collect from some browsers and not others, and "no reports" would
  // then be indistinguishable from "no violations" — which is the exact
  // failure this is fixing.
  `report-uri ${CSP_REPORT_URI}`,
  "report-to csp",
].join("; ");

const securityHeaders = [
  // Names the group `report-to csp` refers to. Required for report-to to do
  // anything at all; without it that directive is inert.
  { key: "Reporting-Endpoints", value: `csp="${CSP_REPORT_URI}"` },
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
  // Proxy ONLY the auth endpoints through this origin, so the refresh cookie
  // is first-party.
  //
  // This is not a tidiness choice, it is the thing that makes the HttpOnly
  // session cookie work at all. The app is served from *.vercel.app and the
  // API from *.duckdns.org — different registrable domains, so a cookie set
  // by the API is a THIRD-PARTY cookie to this page. SameSite=Strict would
  // never send it, SameSite=None is blocked outright by Safari's ITP and is
  // on borrowed time in Chrome, and the symptom in both cases is being signed
  // out on every page load with nothing in the console to explain why.
  //
  // Routing these few paths through Vercel makes the browser see the Set-Cookie
  // as coming from this origin, which it is — so Strict works and Safari is
  // fine.
  //
  // Deliberately NOT a catch-all /api/:path* rewrite: that would put every
  // quote and every panel through Vercel, adding a hop to the hot path and
  // undoing the request work in docs/BASELINE.md. Auth is a handful of calls
  // per session (one refresh per access-token lifetime); market data is
  // thousands, and keeps going straight to the API with a bearer header,
  // which needs no cookie and so has no same-site requirement.
  // NOTE: rewrites are resolved at BUILD time and baked into
  // .next/routes-manifest.json, so NEXT_PUBLIC_API_URL must be present in the
  // BUILD environment — changing it at runtime does nothing and the symptom is
  // a 500 from this proxy with ECONNREFUSED to localhost:8000 in the server
  // log. On Vercel that is automatic (NEXT_PUBLIC_* vars are build-time by
  // definition and already inlined into the bundle), but it does mean pointing
  // the app at a different API requires a redeploy, not just an env change.
  async rewrites() {
    return [
      { source: "/api/v1/auth/:path*", destination: `${API}/api/v1/auth/:path*` },
    ];
  },
};

module.exports = nextConfig;
