import { defineConfig } from "vitest/config";
import path from "node:path";

/** Unit tests for pure logic (no DOM): graph maths, formatters, indicators.
 *  Component/interaction coverage stays in Playwright (`npm run test:e2e`). */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
