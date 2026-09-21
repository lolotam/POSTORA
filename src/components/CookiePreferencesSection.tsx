import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Cookie, Shield, ExternalLink, Check } from "lucide-react";

const COOKIE_CONSENT_KEY = "postora_cookie_consent";

interface CookieConsent {
  essential: boolean;
  functional: boolean;
  thirdParty: boolean;
  timestamp: string;
}

export const CookiePreferencesSection = () => {
  const { toast } = useToast();
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [functional, setFunctional] = useState(true);
  const [thirdParty, setThirdParty] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as CookieConsent;
        setConsent(parsed);
        setFunctional(parsed.functional);
        setThirdParty(parsed.thirdParty);
      } catch {
        // Invalid stored data, use defaults
      }
    }
  }, []);

  const handleSavePreferences = () => {
    setIsSaving(true);
    
    const newConsent: CookieConsent = {
      essential: true, // Always required
      functional,
      thirdParty,
      timestamp: new Date().toISOString(),
    };

    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(newConsent));
    setConsent(newConsent);

    setTimeout(() => {
      setIsSaving(false);
      toast({
        title: "Cookie preferences saved",
        description: "Your cookie preferences have been updated.",
      });
    }, 500);
  };

  const handleResetPreferences = () => {
    localStorage.removeItem(COOKIE_CONSENT_KEY);
    setConsent(null);
    setFunctional(true);
    setThirdParty(true);
    toast({
      title: "Preferences reset",
      description: "Cookie consent banner will appear on your next visit.",
    });
  };

  return (
    <div className="space-y-6">
      {/* Cookie Preferences Card */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Cookie className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">Cookie Preferences</h2>
            <p className="text-sm text-muted-foreground">
              Manage how we use cookies on your device
            </p>
          </div>
        </div>

        {consent && (
          <div className="mb-6 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="w-4 h-4" />
            <span>
              Preferences saved on {new Date(consent.timestamp).toLocaleDateString()}
            </span>
          </div>
        )}

        <div className="space-y-6">
          {/* Essential Cookies */}
          <div className="flex items-start justify-between gap-4 pb-4 border-b border-border">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="font-medium">Essential Cookies</Label>
                <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                  Required
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                These cookies are necessary for the website to function and cannot be disabled. 
                They include authentication, security, and session management.
              </p>
            </div>
            <Switch checked={true} disabled className="opacity-50" />
          </div>

          {/* Functional Cookies */}
          <div className="flex items-start justify-between gap-4 pb-4 border-b border-border">
            <div className="space-y-1">
              <Label htmlFor="functional-cookies" className="font-medium">
                Functional Cookies
              </Label>
              <p className="text-sm text-muted-foreground">
                These cookies enable enhanced functionality like theme preferences, 
                timezone settings, and remembering your language choice.
              </p>
            </div>
            <Switch
              id="functional-cookies"
              checked={functional}
              onCheckedChange={setFunctional}
            />
          </div>

          {/* Third-Party Cookies */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="thirdparty-cookies" className="font-medium">
                Third-Party Cookies
              </Label>
              <p className="text-sm text-muted-foreground">
                These cookies are set by third-party services we integrate with, 
                such as Google/YouTube, Facebook, and other social platforms for OAuth authentication.
              </p>
            </div>
            <Switch
              id="thirdparty-cookies"
              checked={thirdParty}
              onCheckedChange={setThirdParty}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-3 mt-6 pt-6 border-t border-border">
          <Button onClick={handleSavePreferences} disabled={isSaving}>
            {isSaving ? (
              <>
                <Check className="w-4 h-4 me-2" />
                Saved!
              </>
            ) : (
              "Save Preferences"
            )}
          </Button>
          <Button variant="outline" onClick={handleResetPreferences}>
            Reset & Show Banner
          </Button>
        </div>
      </div>

      {/* Privacy Links Card */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">Privacy Documentation</h2>
            <p className="text-sm text-muted-foreground">
              Learn more about how we handle your data
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Link
            to="/privacy"
            className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors"
          >
            <div>
              <p className="font-medium">Privacy Policy</p>
              <p className="text-sm text-muted-foreground">How we collect and use data</p>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </Link>

          <Link
            to="/cookies"
            className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors"
          >
            <div>
              <p className="font-medium">Cookie Policy</p>
              <p className="text-sm text-muted-foreground">Details about cookie usage</p>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </Link>

          <Link
            to="/google-api-disclosure"
            className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors"
          >
            <div>
              <p className="font-medium">Google API Disclosure</p>
              <p className="text-sm text-muted-foreground">YouTube integration details</p>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </Link>

          <Link
            to="/terms"
            className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors"
          >
            <div>
              <p className="font-medium">Terms of Service</p>
              <p className="text-sm text-muted-foreground">Usage terms and conditions</p>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
};
