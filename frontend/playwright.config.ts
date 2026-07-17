import fs from "node:fs";

import { defineConfig } from "@playwright/test";

// Environments that preinstall Chromium (PLAYWRIGHT_BROWSERS_PATH) may carry
// a different build than this Playwright version expects — launch the
// provided binary directly instead of downloading a matching one.
const PROVIDED_CHROMIUM =
  process.env.PLAYWRIGHT_CHROMIUM_PATH
  || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);

/**
 * E2E suite: boots the real FastAPI backend (scratch data dir, seeded e2e
 * admin) and the Next dev server, then drives the app in Chromium.
 * External market-data providers may be unreachable in CI, so specs assert
 * on app-owned structure/data, not live quotes.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single shared backend data dir — keep runs deterministic
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    ...(PROVIDED_CHROMIUM
      ? { launchOptions: { executablePath: PROVIDED_CHROMIUM } }
      : {}),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: ".venv/bin/python -m uvicorn backend.app:app --port 8000",
      cwd: "..",
      url: "http://localhost:8000/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        MOTHERBOARD_ADMIN_USER: "e2e-admin",
        MOTHERBOARD_ADMIN_PASSWORD: "e2e-password-123",
        BACKEND_JWT_SECRET: "e2e-secret-not-for-production-use-32chars!",
        MB_DATA_DIR: "e2e-data",
        PREWARM_SCAN_SEC: "0",
        ALERT_EVAL_SEC: "3600",
      },
    },
    {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8000" },
    },
  ],
});
