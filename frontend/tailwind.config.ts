import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Palette lives in CSS variables (globals.css) so themes can swap it
        // at runtime: html.light for the light theme, html.cb for the
        // colorblind-safe gain/loss pair. RGB-triplet form keeps Tailwind's
        // alpha modifiers (text-amber/90 etc.) working.
        bg:       "rgb(var(--c-bg) / <alpha-value>)",
        bg2:      "rgb(var(--c-bg2) / <alpha-value>)",
        panel:    "rgb(var(--c-panel) / <alpha-value>)",
        panel2:   "rgb(var(--c-panel2) / <alpha-value>)",
        line:     "rgb(var(--c-line) / <alpha-value>)",
        line2:    "rgb(var(--c-line2) / <alpha-value>)",
        txt:      "rgb(var(--c-txt) / <alpha-value>)",
        mut:      "rgb(var(--c-mut) / <alpha-value>)",
        amber:    "rgb(var(--c-amber) / <alpha-value>)",
        green:    "rgb(var(--c-green) / <alpha-value>)",
        red:      "rgb(var(--c-red) / <alpha-value>)",
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"SF Mono"', "Menlo", "Consolas", "monospace"],
        sans: ['"Inter"', "system-ui", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(255,176,0,0.04), 0 8px 28px rgba(0,0,0,0.5)",
      },
      keyframes: {
        in: { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: { in: "in .15s ease-out" },
    },
  },
  plugins: [],
};
export default config;
