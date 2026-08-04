import type { CapacitorConfig } from "@capacitor/cli";

// Wraps the deployed Next.js app (Vercel) in a native shell so it can be
// packaged for the App Store / Play Store. Points at the live production
// URL rather than a static export so the app always reflects the current
// deployed frontend — auth, live quotes, and the FastAPI backend all keep
// working exactly as they do in the browser.
const PRODUCTION_URL =
  process.env.CAPACITOR_SERVER_URL || "https://financial-terminal-peach.vercel.app";

const config: CapacitorConfig = {
  appId: "com.motherboard.terminal",
  appName: "Motherboard Terminal",
  webDir: "public",
  server: {
    url: PRODUCTION_URL,
    cleartext: false,
  },
  ios: {
    contentInset: "automatic",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
