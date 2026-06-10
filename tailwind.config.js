/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}", "./inventory-dashboard.tsx"],
  theme: {
    extend: {
      // ── ROI Email-tracker design tokens (src/email/*) ──────────────────────
      colors: {
        "brand-primary": "#4600F2",
        "brand-primary-hover": "#3500B8",
        "brand-soft": "#F0EAFF",
        "brand-foreground": "#FFFFFF",
        "surface-background": "#F4F5F8",
        "surface-card": "#FFFFFF",
        "surface-subtle": "#F5F5F5",
        "text-primary": "#0A0A0A",
        "text-secondary": "#525252",
        "text-muted": "#737373",
        "text-tertiary": "#9CA3AF",
        "border-subtle": "#E5E5E5",
        "border-strong": "#D4D4D4",
        "border-muted": "#EFEFEF",
        positive: "#16A34A",
        "positive-soft": "#DCFCE7",
        "positive-ring": "#86EFAC",
        negative: "#DC2626",
        "negative-soft": "#FEE2E2",
        warning: "#D97706",
        "warning-soft": "#FEF3C7",
        "info-soft": "#EFF6FF",
        "info-border": "#BFDBFE",
        info: "#1D4ED8",
      },
      borderRadius: { md: "0.5rem", lg: "0.625rem", xl: "0.875rem" },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.04)",
        "card-hover": "0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px -1px rgba(15, 23, 42, 0.04)",
      },
    },
  },
  plugins: [],
};
