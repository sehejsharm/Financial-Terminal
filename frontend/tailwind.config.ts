import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Terminal palette — kept aligned with the Streamlit theme so users
        // moving between the two see one product.
        bg:       "#070809",
        bg2:      "#0c0e12",
        panel:    "#0f1218",
        panel2:   "#12161d",
        line:     "#1c2129",
        line2:    "#262c36",
        txt:      "#dfe3ea",
        mut:      "#767c88",
        amber:    "#ffb000",
        green:    "#1fd286",
        red:      "#ff4d4f",
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
