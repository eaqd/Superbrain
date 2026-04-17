import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        parchment: {
          DEFAULT: "#F4ECD8",
          deep: "#EADFC2",
          edge: "#D9CBA3",
        },
        ink: {
          DEFAULT: "#1F1A17",
          soft: "#3B322B",
          muted: "#6B5E54",
        },
        crimson: {
          DEFAULT: "#8C2A2A",
          deep: "#6B1F1F",
        },
        gold: {
          DEFAULT: "#B8923A",
          soft: "#D9B96B",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        leaf: "0 1px 0 rgba(31,26,23,0.06), 0 14px 28px -20px rgba(31,26,23,0.45)",
        press: "inset 0 2px 0 rgba(31,26,23,0.08)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        flash: {
          "0%": { opacity: "0", transform: "scale(0.92)" },
          "20%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0.92", transform: "scale(1)" },
        },
        shake: {
          "0%,100%": { transform: "translateX(0)" },
          "25%": { transform: "translateX(-6px)" },
          "75%": { transform: "translateX(6px)" },
        },
      },
      animation: {
        rise: "rise 480ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
        flash: "flash 220ms ease-out both",
        shake: "shake 280ms ease-in-out",
      },
    },
  },
  plugins: [],
};
export default config;
