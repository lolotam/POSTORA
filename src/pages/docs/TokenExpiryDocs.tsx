import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { 
  DocsHeader, DocsSidebar, CodeBlock, ParamTable, SectionTitle, SubSection
} from "@/components/docs";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { 
  Clock, Shield, RefreshCw, AlertTriangle, CheckCircle, 
  Zap, Calendar, Info, ExternalLink
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const tokenExpiryData = [
  {
    platform: "tiktok" as ExtendedPlatform,
    name: "TikTok",
    accessToken: "24 hours",
    accessTokenSeconds: 86400,
    refreshToken: "365 days",
    refreshTokenSeconds: 31536000,
    refreshWindow: "6 hours",
    notes: "Refresh token is rolling (resets on each use). Must refresh before expiry or user needs to reauthorize.",
    docUrl: "https://developers.tiktok.com/doc/oauth-user-access-token-management",
    category: "medium",
  },
  {
    platform: "pinterest" as ExtendedPlatform,
    name: "Pinterest",
    accessToken: "1 day",
    accessTokenSeconds: 86400,
    refreshToken: "Continuous",
    refreshTokenSeconds: null,
    refreshWindow: "6 hours",
    notes: "Continuous refresh tokens - each refresh resets the expiry. Previously used 365-day refresh tokens.",
    docUrl: "https://developers.pinterest.com/docs/getting-started/authentication/",
    category: "medium",
  },
  {
    platform: "facebook" as ExtendedPlatform,
    name: "Facebook",
    accessToken: "60 days",
    accessTokenSeconds: 5184000,
    refreshToken: "N/A (long-lived)",
    refreshTokenSeconds: null,
    refreshWindow: "7 days",
    notes: "Uses long-lived access tokens. Short-lived tokens (1 hour) are exchanged for long-lived during OAuth.",
    docUrl: "https://developers.facebook.com/docs/facebook-login/access-tokens/",
    category: "long",
  },
  {
    platform: "instagram" as ExtendedPlatform,
    name: "Instagram",
    accessToken: "60 days",
    accessTokenSeconds: 5184000,
    refreshToken: "N/A (long-lived)",
    refreshTokenSeconds: null,
    refreshWindow: "7 days",
    notes: "Uses Facebook Graph API. Same token lifecycle as Facebook long-lived tokens.",
    docUrl: "https://developers.facebook.com/docs/instagram-basic-display-api/guides/long-lived-access-tokens/",
    category: "long",
  },
  {
    platform: "threads" as ExtendedPlatform,
    name: "Threads",
    accessToken: "60 days",
    accessTokenSeconds: 5184000,
    refreshToken: "N/A (long-lived)",
    refreshTokenSeconds: null,
    refreshWindow: "7 days",
    notes: "Uses Meta's authentication system. Same token lifecycle as Instagram/Facebook.",
    docUrl: "https://developers.facebook.com/docs/threads/",
    category: "long",
  },
  {
    platform: "linkedin" as ExtendedPlatform,
    name: "LinkedIn",
    accessToken: "60 days",
    accessTokenSeconds: 5184000,
    refreshToken: "365 days",
    refreshTokenSeconds: 31536000,
    refreshWindow: "7 days",
    notes: "Refreshing extends both access and refresh token expiry. 3-legged OAuth flow.",
    docUrl: "https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens",
    category: "long",
  },
  {
    platform: "twitter" as ExtendedPlatform,
    name: "Twitter/X",
    accessToken: "2 hours",
    accessTokenSeconds: 7200,
    refreshToken: "6 months",
    refreshTokenSeconds: 15552000,
    refreshWindow: "1 hour",
    notes: "Very short-lived access tokens! Requires frequent refresh. OAuth 2.0 with PKCE.",
    docUrl: "https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code",
    category: "short",
    critical: true,
  },
  {
    platform: "youtube" as ExtendedPlatform,
    name: "YouTube/Google",
    accessToken: "1 hour",
    accessTokenSeconds: 3600,
    refreshToken: "Indefinite*",
    refreshTokenSeconds: null,
    refreshWindow: "30 minutes",
    notes: "Access tokens expire in 1 hour. Refresh tokens last indefinitely unless revoked, unused for 6 months, or user changes password.",
    docUrl: "https://developers.google.com/identity/protocols/oauth2",
    category: "short",
    critical: true,
  },
  {
    platform: "reddit" as ExtendedPlatform,
    name: "Reddit",
    accessToken: "1 hour",
    accessTokenSeconds: 3600,
    refreshToken: "Indefinite",
    refreshTokenSeconds: null,
    refreshWindow: "30 minutes",
    notes: "Very short access token. Requires 'permanent' duration scope during OAuth for refresh token.",
    docUrl: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
    category: "short",
    critical: true,
  },
  {
    platform: "bluesky" as ExtendedPlatform,
    name: "Bluesky",
    accessToken: "~2 hours",
    accessTokenSeconds: 7200,
    refreshToken: "Session-based",
    refreshTokenSeconds: null,
    refreshWindow: "1 hour",
    notes: "Uses AT Protocol with JWT access tokens. Session management via refreshSession endpoint.",
    docUrl: "https://atproto.com/specs/xrpc#authentication",
    category: "short",
    critical: true,
  },
];

const navItems = [
  { id: "overview", label: "Overview", icon: Info },
  { id: "token-table", label: "Token Expiry Table", icon: Clock },
  { id: "short-lived", label: "Short-Lived Tokens", icon: Zap },
  { id: "our-solution", label: "Our Solution", icon: Shield },
  { id: "best-practices", label: "Best Practices", icon: CheckCircle },
];

export default function TokenExpiryDocs() {
  const [activeSection, setActiveSection] = useState("overview");

  const shortLivedPlatforms = tokenExpiryData.filter(p => p.category === "short");
  const mediumLivedPlatforms = tokenExpiryData.filter(p => p.category === "medium");
  const longLivedPlatforms = tokenExpiryData.filter(p => p.category === "long");

  return (
    <div className="min-h-screen bg-background">
      <DocsHeader breadcrumbs={[{ label: "Docs", href: "/docs" }, { label: "Token Expiry" }]} />

      {/* Hero */}
      <div className="border-b bg-background">
        <div className="container mx-auto px-6 py-16">
          <div className="max-w-3xl">
            <Badge className="mb-4 bg-primary/10 text-primary border-primary/30">
              <Clock className="w-3 h-3 me-1" />
              OAuth Token Reference
            </Badge>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Token Expiry Guide
            </h1>
            <p className="text-lg text-muted-foreground mb-6">
              Official documentation on OAuth token expiration times for all supported social media platforms, 
              and how Postora handles automatic token refresh to keep your connections active.
            </p>
            <div className="flex flex-wrap gap-3">
              {tokenExpiryData.map(p => (
                <div key={p.platform} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
                  <PlatformIcon platform={p.platform} size="xs" />
                  <span className="text-xs font-medium">{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-12">
        <div className="grid lg:grid-cols-[260px_1fr] gap-12">
          {/* Sidebar */}
          <aside className="hidden lg:block">
            <nav className="sticky top-24 space-y-1">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeSection === item.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <div className="space-y-16 max-w-4xl min-w-0">
            {/* Overview */}
            <section id="overview">
              <SectionTitle id="overview-title">Overview</SectionTitle>
              <p className="text-muted-foreground mb-6">
                Social media platforms use OAuth 2.0 for authentication, which involves access tokens and refresh tokens 
                with varying expiration times. Understanding these expiry times is crucial for maintaining uninterrupted 
                posting capabilities.
              </p>

              <div className="grid sm:grid-cols-3 gap-4 mb-8">
                <Card className="p-5 bg-red-500/5 border-red-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="w-5 h-5 text-red-500" />
                    <h3 className="font-semibold text-red-500">Short-Lived</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">1-2 hours</p>
                  <div className="flex flex-wrap gap-1">
                    {shortLivedPlatforms.map(p => (
                      <PlatformIcon key={p.platform} platform={p.platform} size="xs" />
                    ))}
                  </div>
                </Card>
                <Card className="p-5 bg-yellow-500/5 border-yellow-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-5 h-5 text-yellow-500" />
                    <h3 className="font-semibold text-yellow-500">Medium-Lived</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">24 hours</p>
                  <div className="flex flex-wrap gap-1">
                    {mediumLivedPlatforms.map(p => (
                      <PlatformIcon key={p.platform} platform={p.platform} size="xs" />
                    ))}
                  </div>
                </Card>
                <Card className="p-5 bg-green-500/5 border-green-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-5 h-5 text-green-500" />
                    <h3 className="font-semibold text-green-500">Long-Lived</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">60 days</p>
                  <div className="flex flex-wrap gap-1">
                    {longLivedPlatforms.map(p => (
                      <PlatformIcon key={p.platform} platform={p.platform} size="xs" />
                    ))}
                  </div>
                </Card>
              </div>

              <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <div className="flex gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-amber-500 mb-1">Why This Matters</h4>
                    <p className="text-sm text-muted-foreground">
                      When tokens expire, scheduled posts will fail and users must manually reconnect their accounts.
                      Postora automatically refreshes tokens before they expire to prevent this.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Token Expiry Table */}
            <section id="token-table">
              <SectionTitle id="table-title">Token Expiry Reference</SectionTitle>
              <p className="text-muted-foreground mb-6">
                Complete reference table showing access token and refresh token expiration for each platform.
              </p>

              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-start p-4 font-semibold">Platform</th>
                        <th className="text-start p-4 font-semibold">Access Token</th>
                        <th className="text-start p-4 font-semibold">Refresh Token</th>
                        <th className="text-start p-4 font-semibold">Refresh Window</th>
                        <th className="text-start p-4 font-semibold">Priority</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokenExpiryData.map((platform, idx) => (
                        <tr key={platform.platform} className={idx % 2 === 0 ? "bg-muted/20" : ""}>
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              <PlatformIcon platform={platform.platform} size="sm" />
                              <span className="font-medium">{platform.name}</span>
                            </div>
                          </td>
                          <td className="p-4">
                            <Badge variant={platform.critical ? "destructive" : "secondary"}>
                              {platform.accessToken}
                            </Badge>
                          </td>
                          <td className="p-4 text-muted-foreground">{platform.refreshToken}</td>
                          <td className="p-4 text-muted-foreground">{platform.refreshWindow}</td>
                          <td className="p-4">
                            {platform.critical ? (
                              <Badge className="bg-red-500/10 text-red-500 border-red-500/30">
                                <Zap className="w-3 h-3 me-1" />
                                Hourly
                              </Badge>
                            ) : platform.category === "medium" ? (
                              <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30">
                                <Clock className="w-3 h-3 me-1" />
                                Daily
                              </Badge>
                            ) : (
                              <Badge className="bg-green-500/10 text-green-500 border-green-500/30">
                                <Shield className="w-3 h-3 me-1" />
                                Weekly
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>

            {/* Platform Details */}
            <section id="short-lived">
              <SectionTitle id="short-title">Platform Details</SectionTitle>
              <p className="text-muted-foreground mb-6">
                Detailed information about each platform's token behavior and special considerations.
              </p>

              <Accordion type="single" collapsible className="w-full">
                {tokenExpiryData.map((platform) => (
                  <AccordionItem key={platform.platform} value={platform.platform}>
                    <AccordionTrigger className="text-start hover:no-underline">
                      <div className="flex items-center gap-3">
                        <PlatformIcon platform={platform.platform} size="sm" />
                        <span className="font-medium">{platform.name}</span>
                        {platform.critical && (
                          <Badge variant="destructive" className="text-xs">
                            Short-lived
                          </Badge>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-4 pt-2">
                        <div className="grid sm:grid-cols-3 gap-4">
                          <div className="p-3 rounded-lg bg-muted/50">
                            <p className="text-xs text-muted-foreground mb-1">Access Token</p>
                            <p className="font-semibold">{platform.accessToken}</p>
                          </div>
                          <div className="p-3 rounded-lg bg-muted/50">
                            <p className="text-xs text-muted-foreground mb-1">Refresh Token</p>
                            <p className="font-semibold">{platform.refreshToken}</p>
                          </div>
                          <div className="p-3 rounded-lg bg-muted/50">
                            <p className="text-xs text-muted-foreground mb-1">Our Refresh Window</p>
                            <p className="font-semibold">{platform.refreshWindow} before expiry</p>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground">{platform.notes}</p>
                        <a 
                          href={platform.docUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                          Official Documentation <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>

            {/* Our Solution */}
            <section id="our-solution">
              <SectionTitle id="solution-title">How Postora Handles This</SectionTitle>
              <p className="text-muted-foreground mb-6">
                Postora implements a robust automatic token refresh system to ensure your connections stay active.
              </p>

              <div className="space-y-6">
                <Card className="p-6 bg-primary/5 border-primary/20">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <RefreshCw className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg mb-2">Hourly Automatic Refresh</h3>
                      <p className="text-muted-foreground mb-3">
                        Our system runs every hour to check all connected accounts. Tokens are refreshed based on 
                        platform-specific windows - 30 minutes before expiry for YouTube/Reddit, 1 hour for Twitter/Bluesky, 
                        6 hours for TikTok/Pinterest, and 7 days for Facebook/Instagram/LinkedIn.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">Cron: Every Hour</Badge>
                        <Badge variant="outline">Platform-Aware</Badge>
                        <Badge variant="outline">Automatic Retry</Badge>
                      </div>
                    </div>
                  </div>
                </Card>

                <Card className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-yellow-500/10 flex items-center justify-center shrink-0">
                      <AlertTriangle className="w-6 h-6 text-yellow-500" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg mb-2">Failure Alerts</h3>
                      <p className="text-muted-foreground mb-3">
                        If a token refresh fails, admins receive email notifications with details about which accounts 
                        need manual reconnection. This prevents scheduled posts from failing silently.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">Email Alerts</Badge>
                        <Badge variant="outline">Admin Notifications</Badge>
                        <Badge variant="outline">Detailed Reports</Badge>
                      </div>
                    </div>
                  </div>
                </Card>

                <Card className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0">
                      <Shield className="w-6 h-6 text-green-500" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg mb-2">Token Health Dashboard</h3>
                      <p className="text-muted-foreground mb-3">
                        Administrators can monitor all connected accounts in real-time through the Token Health Dashboard, 
                        seeing which tokens are healthy, expiring soon, or already expired.
                      </p>
                      <Link to="/admin/token-health">
                        <Button variant="outline" size="sm" className="gap-2">
                          View Dashboard <ExternalLink className="w-3 h-3" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </Card>
              </div>
            </section>

            {/* Best Practices */}
            <section id="best-practices">
              <SectionTitle id="practices-title">Best Practices</SectionTitle>
              <p className="text-muted-foreground mb-6">
                Follow these recommendations to ensure reliable token management.
              </p>

              <div className="space-y-4">
                <div className="flex gap-4 p-4 rounded-lg bg-muted/50">
                  <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold mb-1">Keep Accounts Active</h4>
                    <p className="text-sm text-muted-foreground">
                      Some platforms (like Google) may revoke tokens if unused for 6 months. Regular posting helps maintain active connections.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4 p-4 rounded-lg bg-muted/50">
                  <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold mb-1">Monitor the Health Dashboard</h4>
                    <p className="text-sm text-muted-foreground">
                      Regularly check the Token Health Dashboard to catch any issues before they affect scheduled posts.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4 p-4 rounded-lg bg-muted/50">
                  <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold mb-1">Enable Email Notifications</h4>
                    <p className="text-sm text-muted-foreground">
                      Ensure admin email notifications are enabled to receive alerts about token failures.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4 p-4 rounded-lg bg-muted/50">
                  <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold mb-1">Reconnect Promptly</h4>
                    <p className="text-sm text-muted-foreground">
                      When notified of a failed refresh, reconnect the account as soon as possible to restore functionality.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
