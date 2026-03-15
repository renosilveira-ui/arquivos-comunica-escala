/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#0B1120",
        surface: "#141B2D",
        surface2: "#1E293B",
        border: "rgba(148, 163, 184, 0.15)",
        accent: "#3B82F6",
        text: "#F1F5F9",
        text2: "#94A3B8",
        foreground: "#F1F5F9",
        warning: "#F59E0B",
        primary: "#3B82F6",
      },
    },
  },
  plugins: [],
};
