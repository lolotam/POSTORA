import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      // No max-width caps. The app runs full-bleed, so .container contributes gutters and
      // centring only; leaving the old 1400px ceiling here would have quietly re-capped the
      // 77 places that use it even after the layout shell was widened.
      screens: {},
    },
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['Merriweather', 'serif'],
        heading: ['"Noto Serif"', 'serif'],
        cairo: ['Cairo', 'sans-serif'],
      },
      colors: {
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // Platform colors (legacy single tokens kept for backwards compat)
        facebook: "hsl(var(--facebook))",
        instagram: "hsl(var(--instagram))",
        tiktok: "hsl(var(--tiktok))",
        twitter: "hsl(var(--twitter))",
        linkedin: "hsl(var(--linkedin))",
        // Brand gradient pairs for 3D platform chips
        brand: {
          facebook: "hsl(var(--facebook))",
          "facebook-dark": "hsl(var(--facebook-dark))",
          instagram: "hsl(var(--instagram))",
          "instagram-dark": "hsl(var(--instagram-dark))",
          tiktok: "hsl(var(--tiktok))",
          "tiktok-dark": "hsl(var(--tiktok-dark))",
          twitter: "hsl(var(--twitter))",
          "twitter-dark": "hsl(var(--twitter-dark))",
          linkedin: "hsl(var(--linkedin))",
          "linkedin-dark": "hsl(var(--linkedin-dark))",
          youtube: "hsl(var(--youtube))",
          "youtube-dark": "hsl(var(--youtube-dark))",
          pinterest: "hsl(var(--pinterest))",
          "pinterest-dark": "hsl(var(--pinterest-dark))",
          threads: "hsl(var(--threads))",
          "threads-dark": "hsl(var(--threads-dark))",
          bluesky: "hsl(var(--bluesky))",
          "bluesky-dark": "hsl(var(--bluesky-dark))",
          reddit: "hsl(var(--reddit))",
          "reddit-dark": "hsl(var(--reddit-dark))",
          whatsapp: "hsl(var(--whatsapp))",
          "whatsapp-dark": "hsl(var(--whatsapp-dark))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(20px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
        "scroll-left": {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "scroll-right": {
          "0%": { transform: "translateX(-50%)" },
          "100%": { transform: "translateX(0)" },
        },
        "bounce-dot": {
          "0%, 100%": { transform: "translateY(0)", opacity: "0.4" },
          "50%": { transform: "translateY(-8px)", opacity: "1" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0) translateX(0)", opacity: "0.4" },
          "25%": { transform: "translateY(-30px) translateX(15px)", opacity: "0.8" },
          "50%": { transform: "translateY(-60px) translateX(-10px)", opacity: "0.6" },
          "75%": { transform: "translateY(-30px) translateX(20px)", opacity: "0.8" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.5s ease-out forwards",
        "slide-in-right": "slide-in-right 0.4s ease-out forwards",
        "scale-in": "scale-in 0.3s ease-out forwards",
        shimmer: "shimmer 1.5s linear infinite",
        "scroll-left": "scroll-left 35s linear infinite",
        "scroll-right": "scroll-right 35s linear infinite",
        "bounce-dot": "bounce-dot 0.8s ease-in-out infinite",
        float: "float 20s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
