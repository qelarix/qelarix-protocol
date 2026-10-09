import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#000000",
        foreground: "#F4F7FB",
        purple: {
          DEFAULT: "#7B61FF",
          light: "#A89BFF",
          dark: "#5A45CC",
        },
        blue: {
          DEFAULT: "#3BE7FF",
          light: "#7FEFFF",
          dark: "#1ABCCC",
        },
        qelarix: {
          obsidian: '#050505',
          silver: '#C7CDD6',
          white: '#F4F7FB',
          violet: '#7B61FF',
          cyan: '#3BE7FF',
          plasma: '#112B45',
          card: '#111318',
          border: '#2A2F3A',
          textSecondary: '#AAB2BF',
          textMuted: '#6B7280',
          dark: '#1A1D24',
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "hero-gradient":
          "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(123,97,255,0.15) 0%, transparent 70%)",
      },
      animation: {
        "fade-in": "fadeIn 0.5s ease-in-out",
        "slide-up": "slideUp 0.6s ease-out",
        "count-up": "countUp 2s ease-out",
        "scroll-x": "scrollX 30s linear infinite",
        shimmer: "shimmer 2s infinite",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scrollX: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
export default config;
