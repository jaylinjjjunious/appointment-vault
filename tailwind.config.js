/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/views/**/*.ejs", "./src/public/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        display: ["\"Space Grotesk\"", "ui-sans-serif", "system-ui"],
        body: ["\"Inter\"", "ui-sans-serif", "system-ui"],
      },
      boxShadow: {
        glass: "0 12px 40px rgba(0, 0, 0, 0.55)",
        "glass-hover": "0 18px 60px rgba(0, 0, 0, 0.65)",
        glow: "0 0 24px rgba(245, 166, 35, 0.35)",
        "glow-strong": "0 0 36px rgba(245, 166, 35, 0.5)",
      },
      backgroundImage: {
        "vault-grid":
          "radial-gradient(circle at 12% 10%, rgba(58, 35, 19, 0.45), transparent 55%), radial-gradient(circle at 88% 18%, rgba(42, 26, 16, 0.5), transparent 50%), linear-gradient(160deg, rgba(9, 9, 11, 1), rgba(11, 11, 13, 1))",
      },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        vaultDark: {
          primary: "#F5A623",
          secondary: "#2A1A10",
          accent: "#FFB347",
          neutral: "#151214",
          "base-100": "#0B0B0C",
          "base-200": "#111013",
          "base-300": "#151214",
          info: "#8AB4F8",
          success: "#34D399",
          warning: "#F5A623",
          error: "#F87171",
        },
      },
      "light",
    ],
    darkTheme: "vaultDark",
    base: true,
    styled: true,
    utils: true,
    logs: false,
  },
};
