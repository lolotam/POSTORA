import { Link } from "react-router-dom";
import { useState, useEffect, lazy, Suspense } from "react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { CookieConsent } from "@/components/CookieConsent";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowRight, Sparkles, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Lazy-load below-fold sections
const LandingDashboardMockup = lazy(() => import("@/components/landing/LandingDashboardMockup"));
const LandingFeatures = lazy(() => import("@/components/landing/LandingFeatures"));
const LandingPricing = lazy(() => import("@/components/landing/LandingPricing"));
const LandingTrustedBy = lazy(() => import("@/components/landing/LandingTrustedBy"));
const LandingTestimonials = lazy(() => import("@/components/landing/LandingTestimonials"));
const LandingFAQ = lazy(() => import("@/components/landing/LandingFAQ"));
const LandingCTA = lazy(() => import("@/components/landing/LandingCTA"));

// Navigation items for smooth scrolling
const navItems = [
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
  { label: "Testimonials", href: "#testimonials" },
  { label: "FAQ", href: "#faq" },
];

// Smooth scroll function
const scrollToSection = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
  e.preventDefault();
  const element = document.querySelector(href);
  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }
};

const platforms: Platform[] = ["instagram", "facebook", "tiktok", "twitter", "linkedin", "youtube", "pinterest", "threads", "bluesky", "reddit"];

// Vibrant particle colors for hero background
const particleColors = [
  "bg-neutral-900 dark:bg-neutral-800", "bg-neutral-900 dark:bg-neutral-800", "bg-blue-500", "bg-cyan-500", "bg-emerald-500",
  "bg-yellow-500", "bg-orange-500", "bg-rose-500", "bg-neutral-900 dark:bg-neutral-800", "bg-teal-500",
];

// Floating particles for hero background — CSS-only
const FloatingParticles = () => {
  const particles = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    size: Math.random() * 6 + 3,
    x: Math.random() * 100,
    y: Math.random() * 100,
    duration: Math.random() * 20 + 15,
    delay: Math.random() * 5,
    color: particleColors[i % particleColors.length],
  }));

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((particle) => (
        <div
          key={particle.id}
          className={`absolute rounded-full ${particle.color} animate-float`}
          style={{
            width: particle.size,
            height: particle.size,
            left: `${particle.x}%`,
            top: `${particle.y}%`,
            boxShadow: `0 0 ${particle.size * 2}px currentColor`,
            animationDuration: `${particle.duration}s`,
            animationDelay: `${particle.delay}s`,
          }}
        />
      ))}
    </div>
  );
};

// Duplicate for infinite scroll
const duplicatedPlatforms = [...platforms, ...platforms, ...platforms];

export default function Landing() {
  const [isScrolled, setIsScrolled] = useState(false);

  // Track scroll position for sticky header
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden scroll-smooth">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute bottom-0 start-1/2 -translate-x-1/2 w-full h-1/2 bg-accent" />
        <FloatingParticles />
      </div>

      {/* Sticky Header */}
      <header
        className={`fixed top-0 start-0 end-0 z-50 border-b transition-all duration-300 ${isScrolled
          ? "border-border bg-background h-14"
          : "border-border/50 bg-background h-16"
          }`}
      >
        <div className="container mx-auto px-4 sm:px-6 h-full flex items-center justify-between gap-2 transition-all duration-300">
          <div className={`transition-transform duration-200 ${isScrolled ? "scale-90" : "scale-100"}`}>
            <Logo />
          </div>

          {/* Navigation Links */}
          <nav className="hidden md:flex items-center gap-6">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => scrollToSection(e, item.href)}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {item.label}
              </a>
            ))}
            <a href="https://postora.cloud/privacy" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Privacy
            </a>
          </nav>

          <div className="flex items-center gap-1 sm:gap-4 shrink-0">
            <ThemeToggle />
            <Link to="/auth">
              <Button variant="ghost" size={isScrolled ? "sm" : "default"}>Sign In</Button>
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="gradient" size={isScrolled ? "sm" : "default"}>Get Started</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/auth" className="cursor-pointer">
                    <Sparkles className="w-4 h-4 me-2" />
                    Postora
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="https://marketero.postora.cloud" target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                    <ExternalLink className="w-4 h-4 me-2" />
                    Marketero
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Spacer for fixed header */}
      <div className="h-16" />

      {/* Main Content */}
      <main>
        {/* Hero Section */}
        <section className="relative z-10 container mx-auto px-6 pt-20 pb-16 text-center">
          <div className="max-w-4xl mx-auto">
            <div
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-secondary/50 mb-8 animate-fade-in"
            >
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm text-muted-foreground">
                Now supporting multi-image carousels
              </span>
            </div>

            <h1
              className="text-5xl md:text-7xl font-bold tracking-tight mb-6 animate-fade-in"
              style={{ animationDelay: "0.1s" }}
            >
              One Platform.
              <br />
              <span className="gradient-text">All Your Socials.</span>
            </h1>

            <p
              className="text-xl text-muted-foreground max-w-2xl mx-auto mb-4 animate-fade-in"
              style={{ animationDelay: "0.2s" }}
            >
              Postora helps creators and marketers schedule, create, and publish content
              across Instagram, YouTube, TikTok, LinkedIn, and 7 more platforms — all from one beautiful dashboard.
            </p>

            <p
              className="text-sm text-muted-foreground/70 max-w-2xl mx-auto mb-10 animate-fade-in"
              style={{ animationDelay: "0.25s" }}
            >
              Postora integrates with Google APIs (YouTube Data API) to manage publishing on your channels,
              in full compliance with{" "}
              <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">
                Google's privacy policies
              </a>
              {" "}and{" "}
              <a href="https://postora.cloud/google-api-disclosure" className="underline hover:text-foreground transition-colors">
                Limited Use requirements
              </a>.
            </p>

            <div
              className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-fade-in"
              style={{ animationDelay: "0.3s" }}
            >
              <a href="https://postora.cloud/auth?mode=signup">
                <Button size="xl" variant="gradient" className="group">
                  Start Posting Free
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Button>
              </a>
              <a href="https://postora.cloud/docs" target="_blank" rel="noopener noreferrer">
                <Button size="xl" variant="outline">
                  View Documentation
                </Button>
              </a>
            </div>

            <p
              className="text-xs text-muted-foreground animate-fade-in"
              style={{ animationDelay: "0.35s" }}
            >
              By signing up, you agree to our{" "}
              <a href="https://postora.cloud/terms" className="underline hover:text-foreground transition-colors">Terms</a>
              {" "}and{" "}
              <a href="https://postora.cloud/privacy" className="underline hover:text-foreground transition-colors">Privacy Policy</a>.
            </p>

            {/* Platform Icons Carousel - CSS Auto Scrolling */}
            <div
              className="relative overflow-hidden py-4 animate-fade-in"
              style={{ animationDelay: "0.4s" }}
            >
              {/* Gradient masks for smooth edges */}
              <div className="absolute start-0 top-0 bottom-0 w-20 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
              <div className="absolute end-0 top-0 bottom-0 w-20 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

              <div className="flex gap-8 animate-scroll-left w-max">
                {duplicatedPlatforms.map((platform, index) => (
                  <div
                    key={`${platform}-${index}`}
                    className="flex flex-col items-center gap-3 flex-shrink-0 transition-transform duration-300 hover:scale-110 hover:-translate-y-1"
                  >
                    <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-secondary/80 flex items-center justify-center border border-border/50 shadow-lg hover:shadow-xl hover:border-primary/30 transition-all duration-300">
                      <PlatformIcon platform={platform} size="xl" />
                    </div>
                    <span className="text-sm font-medium text-muted-foreground">
                      {getPlatformName(platform)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Below-fold lazy-loaded sections */}
        <Suspense fallback={null}>
          <LandingDashboardMockup />
          <LandingFeatures />
          <LandingPricing />
          <LandingTrustedBy />
          <LandingTestimonials />
          <LandingFAQ />
          <LandingCTA />
        </Suspense>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border bg-card/50">
        <div className="container mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <Logo size="sm" />
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
              <a href="https://postora.cloud/docs" target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Documentation
              </a>
              <a href="https://postora.cloud/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Privacy Policy
              </a>
              <a href="https://postora.cloud/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Terms of Service
              </a>
              <a href="https://postora.cloud/cookies" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Cookie Policy
              </a>
              <a href="https://postora.cloud/google-api-disclosure" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Google API Disclosure
              </a>
            </div>
            <p className="text-sm text-muted-foreground">
              © 2026 Postora. A product developed and operated by WALEED PROLIFE LLC. All rights reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* Cookie Consent Banner */}
      <CookieConsent />
    </div>
  );
}
