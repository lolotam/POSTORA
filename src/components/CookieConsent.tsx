import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Cookie, X } from "lucide-react";

const COOKIE_CONSENT_KEY = "postora_cookie_consent";

export const CookieConsent = () => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Check if user has already made a choice
    const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!consent) {
      // Delay showing the banner slightly for better UX
      const timer = setTimeout(() => setIsVisible(true), 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAcceptAll = () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({
      essential: true,
      functional: true,
      thirdParty: true,
      timestamp: new Date().toISOString()
    }));
    setIsVisible(false);
  };

  const handleAcceptEssential = () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({
      essential: true,
      functional: false,
      thirdParty: false,
      timestamp: new Date().toISOString()
    }));
    setIsVisible(false);
  };

  const handleDismiss = () => {
    // Just hide the banner without storing preference
    // It will show again on next visit
    setIsVisible(false);
  };

  if (!isVisible) return null;

  return (
    <div className="fixed bottom-0 start-0 end-0 z-50 p-4 animate-fade-in">
      <div className="container mx-auto max-w-4xl">
        <div className="relative bg-card border border-border rounded-2xl shadow-2xl p-6">
          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="absolute top-4 end-4 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss cookie notice"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            {/* Icon and Content */}
            <div className="flex items-start gap-4 flex-1">
              <div className="hidden sm:flex w-12 h-12 rounded-xl bg-primary/10 items-center justify-center shrink-0">
                <Cookie className="h-6 w-6 text-primary" />
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold text-lg">We use cookies 🍪</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  We use cookies to enhance your experience, remember your preferences, and enable social media integrations. 
                  You can customize your preferences or accept all cookies.{" "}
                  <Link to="/cookies" className="text-primary font-medium underline hover:no-underline">
                    Learn more about our cookie policy
                  </Link>
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto shrink-0">
              <Button
                variant="outline"
                onClick={handleAcceptEssential}
                className="whitespace-nowrap"
              >
                Essential Only
              </Button>
              <Button
                variant="gradient"
                onClick={handleAcceptAll}
                className="whitespace-nowrap"
              >
                Accept All
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Hook to check cookie consent status
export const useCookieConsent = () => {
  const [consent, setConsent] = useState<{
    essential: boolean;
    functional: boolean;
    thirdParty: boolean;
    timestamp: string;
  } | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (stored) {
      try {
        setConsent(JSON.parse(stored));
      } catch {
        setConsent(null);
      }
    }
  }, []);

  return consent;
};
