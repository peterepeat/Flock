import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "var(--surface)",
          mid: "var(--surface-mid)",
          lift: "var(--surface-lift)",
        },
        text: {
          DEFAULT: "var(--text)",
          dim: "var(--text-dim)",
        },
        fog: "var(--fog)",
        together: {
          DEFAULT: "var(--together)",
          glow: "var(--together-glow)",
        },
        accent: "var(--accent)",
        // Participant route colours
        p1: "var(--p1)",
        p2: "var(--p2)",
        p3: "var(--p3)",
        p4: "var(--p4)",
        p5: "var(--p5)",
        p6: "var(--p6)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-dm-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        panel: "0 8px 40px rgba(0,0,0,0.45)",
        glow: "0 0 24px var(--together-glow)",
      },
    },
  },
  plugins: [],
};

export default config;
