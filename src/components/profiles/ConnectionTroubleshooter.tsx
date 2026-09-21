import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  XCircle,
  RefreshCw,
  Globe,
  Link,
  ExternalLink,
  Bug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Platform } from "@/lib/types";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { getPublicConfig, getCachedPublicConfig } from "@/lib/publicConfig";

interface OAuthError {
  platform: Platform;
  error: string;
  timestamp: Date;
  details?: string;
}

interface PlatformOAuthConfig {
  platform: Platform;
  expectedRedirectUri: string;
  registeredDomains: string[];
  lastError?: OAuthError;
  isConfigured: boolean;
}

// Registered redirect URIs from client-metadata.json
const BLUESKY_REDIRECT_URIS = [
  "https://postora.cloud/profiles",
  "https://postora.lovable.app/profiles",
  "https://id-preview--b52780c5-cd0a-406b-a6a2-d9724d901b18.lovable.app/profiles",
];

const FACEBOOK_REQUIRED_DOMAINS = ["postora.cloud", "postora.lovable.app"];

interface ConnectionTroubleshooterProps {
  className?: string;
}

export function ConnectionTroubleshooter({ className }: ConnectionTroubleshooterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [oauthErrors, setOauthErrors] = useState<OAuthError[]>([]);
  const [facebookAppId, setFacebookAppId] = useState<string>("");
  const currentDomain = typeof window !== "undefined" ? window.location.origin : "";
  const currentRedirectUri = `${currentDomain}/profiles`;

  // Check if current domain is registered for Bluesky
  const isBlueskyDomainRegistered = BLUESKY_REDIRECT_URIS.some((uri) => uri.startsWith(currentDomain));

  // Fetch Facebook App ID dynamically
  useEffect(() => {
    const cached = getCachedPublicConfig();
    if (cached?.FACEBOOK_APP_ID) {
      setFacebookAppId(cached.FACEBOOK_APP_ID);
    } else {
      getPublicConfig().then((config) => setFacebookAppId(config.FACEBOOK_APP_ID));
    }
  }, []);

  // Load OAuth errors from sessionStorage
  useEffect(() => {
    try {
      const storedErrors = sessionStorage.getItem("oauth_errors");
      if (storedErrors) {
        const parsed = JSON.parse(storedErrors);
        setOauthErrors(
          parsed.map((e: any) => ({
            ...e,
            timestamp: new Date(e.timestamp),
          })),
        );
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, []);

  // Save OAuth error
  const recordOAuthError = (platform: Platform, error: string, details?: string) => {
    const newError: OAuthError = {
      platform,
      error,
      timestamp: new Date(),
      details,
    };
    const updated = [newError, ...oauthErrors.slice(0, 9)]; // Keep last 10
    setOauthErrors(updated);
    sessionStorage.setItem("oauth_errors", JSON.stringify(updated));
  };

  const clearErrors = () => {
    setOauthErrors([]);
    sessionStorage.removeItem("oauth_errors");
  };

  // Get latest Facebook debug info
  const [fbDebug, setFbDebug] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("fb_last_oauth_debug");
      if (stored) setFbDebug(JSON.parse(stored));
    } catch {
      /* ignore */
    }
  }, []);

  const isFacebookDomainRegistered = FACEBOOK_REQUIRED_DOMAINS.some((d) => currentDomain.includes(d));

  const platformConfigs: PlatformOAuthConfig[] = [
    {
      platform: "bluesky",
      expectedRedirectUri: currentRedirectUri,
      registeredDomains: BLUESKY_REDIRECT_URIS,
      lastError: oauthErrors.find((e) => e.platform === "bluesky"),
      isConfigured: isBlueskyDomainRegistered,
    },
    {
      platform: "facebook",
      expectedRedirectUri: currentDomain,
      registeredDomains: FACEBOOK_REQUIRED_DOMAINS.map((d) => `https://${d}`),
      lastError: oauthErrors.find((e) => e.platform === "facebook"),
      isConfigured: isFacebookDomainRegistered,
    },
  ];

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Bug className="w-5 h-5 text-muted-foreground" />
                <div>
                  <CardTitle className="text-base">Connection Troubleshooter</CardTitle>
                  <CardDescription>Debug OAuth redirect issues and domain configuration</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {oauthErrors.length > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    {oauthErrors.length} error{oauthErrors.length > 1 ? "s" : ""}
                  </Badge>
                )}
                <ChevronDown
                  className={cn("w-5 h-5 transition-transform text-muted-foreground", isOpen && "rotate-180")}
                />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="space-y-6 pt-0">
            {/* Current Domain Info */}
            <div className="p-4 rounded-lg bg-muted/30 border space-y-3">
              <h4 className="font-medium flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Current Environment
              </h4>
              <div className="grid gap-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Domain:</span>
                  <code className="bg-background px-2 py-0.5 rounded text-xs">{currentDomain}</code>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">OAuth Redirect URI:</span>
                  <code className="bg-background px-2 py-0.5 rounded text-xs">{currentRedirectUri}</code>
                </div>
              </div>
            </div>

            {/* Platform-specific configs */}
            <div className="space-y-4">
              <h4 className="font-medium">Platform OAuth Status</h4>

              {platformConfigs.map((config) => (
                <div
                  key={config.platform}
                  className={cn(
                    "p-4 rounded-lg border",
                    config.isConfigured ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5",
                  )}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <PlatformIcon platform={config.platform} className="w-5 h-5" />
                      <span className="font-medium">{getPlatformName(config.platform)}</span>
                    </div>
                    {config.isConfigured ? (
                      <Badge className="bg-green-500/10 text-green-600 border-green-500/30">
                        <CheckCircle2 className="w-3 h-3 me-1" />
                        Configured
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-600 border-amber-500/30">
                        <AlertCircle className="w-3 h-3 me-1" />
                        Domain Not Registered
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Registered redirect URIs:</span>
                      <div className="mt-1 space-y-1">
                        {config.registeredDomains.map((uri, i) => (
                          <div key={i} className="flex items-center gap-2">
                            {uri === currentRedirectUri ? (
                              <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
                            ) : (
                              <div className="w-3 h-3 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <code className="text-xs bg-background px-2 py-0.5 rounded break-all">{uri}</code>
                          </div>
                        ))}
                      </div>
                    </div>

                    {!config.isConfigured && (
                      <div className="p-3 mt-2 rounded bg-amber-500/10 border border-amber-500/30">
                        <p className="text-amber-700 dark:text-amber-400 text-xs">
                          <strong>Action needed:</strong> Add{" "}
                          <code className="bg-background px-1 rounded">
                            {config.platform === "facebook" ? currentDomain : currentRedirectUri}
                          </code>{" "}
                          to
                          {config.platform === "bluesky" && " public/client-metadata.json redirect_uris array"}
                          {config.platform === "facebook" &&
                            " Meta Developer Portal → App Settings → App Domains AND Facebook Login → Settings → Allowed Domains for the JavaScript SDK"}
                        </p>
                      </div>
                    )}

                    {config.lastError && (
                      <div className="p-3 mt-2 rounded bg-destructive/10 border border-destructive/30">
                        <div className="flex items-start gap-2">
                          <XCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="font-medium text-destructive">{config.lastError.error}</p>
                            {config.lastError.details && (
                              <p className="text-xs text-muted-foreground mt-1">{config.lastError.details}</p>
                            )}
                            <p className="text-xs text-muted-foreground mt-1">
                              {config.lastError.timestamp.toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Recent OAuth Errors */}
            {oauthErrors.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">Recent OAuth Errors</h4>
                  <Button variant="ghost" size="sm" onClick={clearErrors}>
                    <RefreshCw className="w-3 h-3 me-1" />
                    Clear
                  </Button>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {oauthErrors.map((error, i) => (
                    <div key={i} className="p-3 rounded bg-destructive/5 border border-destructive/20 text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <PlatformIcon platform={error.platform} className="w-4 h-4" />
                        <span className="font-medium">{getPlatformName(error.platform)}</span>
                        <span className="text-xs text-muted-foreground ms-auto">
                          {error.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-destructive">{error.error}</p>
                      {error.details && <p className="text-xs text-muted-foreground mt-1">{error.details}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Facebook Debug Info */}
            {fbDebug && (
              <div className="space-y-3">
                <h4 className="font-medium">Last Facebook OAuth Debug</h4>
                <div className="p-3 rounded bg-muted/30 border text-xs font-mono space-y-1">
                  <div>
                    <span className="text-muted-foreground">Reason:</span> {String(fbDebug.reason)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Origin:</span> {String(fbDebug.origin)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">SDK Loaded:</span> {String(fbDebug.sdkLoaded)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Login Status:</span> {String(fbDebug.loginStatus)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Time:</span> {String(fbDebug.timestamp)}
                  </div>
                </div>
              </div>
            )}

            {/* Help Links */}
            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2">Helpful Resources</h4>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a
                    href="https://docs.bsky.app/docs/advanced-guides/oauth-client"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="w-3 h-3 me-1" />
                    Bluesky OAuth Docs
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={facebookAppId ? `https://developers.facebook.com/apps/${facebookAppId}/settings/basic/` : "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="w-3 h-3 me-1" />
                    Meta App Settings
                  </a>
                </Button>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// Export helper to record errors from other components
export function recordBlueskyOAuthError(error: string, details?: string) {
  try {
    const stored = sessionStorage.getItem("oauth_errors");
    const errors = stored ? JSON.parse(stored) : [];
    const newError = {
      platform: "bluesky" as Platform,
      error,
      timestamp: new Date().toISOString(),
      details,
    };
    errors.unshift(newError);
    sessionStorage.setItem("oauth_errors", JSON.stringify(errors.slice(0, 10)));
  } catch (e) {
    console.error("Failed to record OAuth error:", e);
  }
}
