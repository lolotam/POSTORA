import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { 
  Shield, 
  Database, 
  Server, 
  Bell, 
  CreditCard, 
  FileText, 
  Lock, 
  Globe, 
  Zap,
  CheckCircle2,
  AlertTriangle,
  ExternalLink
} from "lucide-react";

interface ChecklistItem {
  id: string;
  label: string;
  description: string;
  category: string;
  priority: "critical" | "high" | "medium" | "low";
  link?: string;
  linkLabel?: string;
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  // Security
  {
    id: "ssl",
    label: "SSL Certificate Enabled",
    description: "Ensure HTTPS is enabled for all traffic",
    category: "security",
    priority: "critical",
    link: "https://docs.lovable.dev/tips-tricks/custom-domain",
    linkLabel: "Custom Domain Docs",
  },
  {
    id: "rls",
    label: "Row Level Security (RLS) Enabled",
    description: "All database tables have proper RLS policies",
    category: "security",
    priority: "critical",
    link: "https://supabase.com/docs/guides/auth/row-level-security",
    linkLabel: "RLS Docs",
  },
  {
    id: "api-keys",
    label: "API Keys Secured",
    description: "All sensitive API keys stored as environment secrets",
    category: "security",
    priority: "critical",
  },
  {
    id: "rate-limiting",
    label: "Rate Limiting Configured",
    description: "Edge functions have rate limits to prevent abuse",
    category: "security",
    priority: "high",
  },
  {
    id: "cors",
    label: "CORS Configured",
    description: "Proper CORS headers set on all endpoints",
    category: "security",
    priority: "high",
  },
  {
    id: "mfa",
    label: "MFA Available for Users",
    description: "Two-factor authentication option enabled",
    category: "security",
    priority: "medium",
  },

  // Database
  {
    id: "backups",
    label: "Database Backups Enabled",
    description: "Automatic daily backups configured",
    category: "database",
    priority: "critical",
    link: "https://supabase.com/dashboard/project/_/settings/database",
    linkLabel: "Database Settings",
  },
  {
    id: "indexes",
    label: "Database Indexes Created",
    description: "Performance indexes on frequently queried columns",
    category: "database",
    priority: "high",
  },
  {
    id: "pitr",
    label: "Point-in-Time Recovery (Pro)",
    description: "Enable PITR for disaster recovery",
    category: "database",
    priority: "medium",
    link: "https://supabase.com/docs/guides/platform/backups",
    linkLabel: "Backup Docs",
  },

  // Infrastructure
  {
    id: "edge-deployed",
    label: "Edge Functions Deployed",
    description: "All edge functions deployed to production",
    category: "infrastructure",
    priority: "critical",
  },
  {
    id: "cron-jobs",
    label: "Cron Jobs Configured",
    description: "Scheduled tasks set up (token refresh, cleanup)",
    category: "infrastructure",
    priority: "high",
    link: "https://supabase.com/dashboard/project/_/integrations/cron",
    linkLabel: "Cron Dashboard",
  },
  {
    id: "cdn",
    label: "CDN for Static Assets",
    description: "Using Cloudflare or similar CDN",
    category: "infrastructure",
    priority: "medium",
  },

  // Monitoring
  {
    id: "error-monitoring",
    label: "Error Monitoring Setup",
    description: "System logs capturing errors and issues",
    category: "monitoring",
    priority: "high",
  },
  {
    id: "alerts",
    label: "Alert Notifications",
    description: "Email alerts for critical failures",
    category: "monitoring",
    priority: "high",
  },
  {
    id: "analytics",
    label: "Analytics Dashboard",
    description: "User and resource usage tracking",
    category: "monitoring",
    priority: "medium",
  },
  {
    id: "uptime",
    label: "Uptime Monitoring",
    description: "External service monitoring (UptimeRobot, etc.)",
    category: "monitoring",
    priority: "medium",
    link: "https://uptimerobot.com/",
    linkLabel: "UptimeRobot",
  },

  // Payments
  {
    id: "stripe-live",
    label: "Stripe Live Mode",
    description: "Switch from test to live API keys",
    category: "payments",
    priority: "critical",
    link: "https://dashboard.stripe.com/apikeys",
    linkLabel: "Stripe Dashboard",
  },
  {
    id: "webhooks",
    label: "Stripe Webhooks Configured",
    description: "Payment webhooks pointing to production",
    category: "payments",
    priority: "critical",
  },
  {
    id: "subscription-plans",
    label: "Subscription Plans Created",
    description: "All pricing plans set up in Stripe",
    category: "payments",
    priority: "high",
  },

  // Legal
  {
    id: "privacy-policy",
    label: "Privacy Policy",
    description: "GDPR-compliant privacy policy published",
    category: "legal",
    priority: "critical",
    link: "/privacy",
    linkLabel: "View Policy",
  },
  {
    id: "terms",
    label: "Terms of Service",
    description: "Terms of service published",
    category: "legal",
    priority: "critical",
    link: "/terms",
    linkLabel: "View Terms",
  },
  {
    id: "cookie-consent",
    label: "Cookie Consent Banner",
    description: "Cookie consent implemented",
    category: "legal",
    priority: "high",
  },
  {
    id: "google-disclosure",
    label: "Google API Disclosure",
    description: "Required disclosure for Google OAuth",
    category: "legal",
    priority: "high",
    link: "/google-api-disclosure",
    linkLabel: "View Disclosure",
  },

  // Performance
  {
    id: "lazy-loading",
    label: "Lazy Loading Enabled",
    description: "Route-based code splitting implemented",
    category: "performance",
    priority: "medium",
  },
  {
    id: "image-optimization",
    label: "Image Optimization",
    description: "Images compressed and properly sized",
    category: "performance",
    priority: "medium",
  },
  {
    id: "caching",
    label: "API Response Caching",
    description: "React Query caching configured",
    category: "performance",
    priority: "low",
  },
];

const CATEGORIES = [
  { id: "security", label: "Security", icon: Shield, color: "text-red-500" },
  { id: "database", label: "Database", icon: Database, color: "text-blue-500" },
  { id: "infrastructure", label: "Infrastructure", icon: Server, color: "text-foreground" },
  { id: "monitoring", label: "Monitoring", icon: Bell, color: "text-yellow-500" },
  { id: "payments", label: "Payments", icon: CreditCard, color: "text-green-500" },
  { id: "legal", label: "Legal", icon: FileText, color: "text-orange-500" },
  { id: "performance", label: "Performance", icon: Zap, color: "text-cyan-500" },
];

const STORAGE_KEY = "admin-launch-checklist";

export default function AdminLaunchChecklist() {
  const [completedItems, setCompletedItems] = useState<Set<string>>(new Set());

  // Load from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setCompletedItems(new Set(JSON.parse(saved)));
    }
  }, []);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...completedItems]));
  }, [completedItems]);

  const toggleItem = (id: string) => {
    setCompletedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const totalItems = CHECKLIST_ITEMS.length;
  const completedCount = completedItems.size;
  const progressPercent = (completedCount / totalItems) * 100;

  const criticalItems = CHECKLIST_ITEMS.filter(i => i.priority === "critical");
  const criticalCompleted = criticalItems.filter(i => completedItems.has(i.id)).length;
  const allCriticalDone = criticalCompleted === criticalItems.length;

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case "critical":
        return <Badge variant="destructive">Critical</Badge>;
      case "high":
        return <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-500/30">High</Badge>;
      case "medium":
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30">Medium</Badge>;
      case "low":
        return <Badge variant="secondary">Low</Badge>;
      default:
        return null;
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Launch Checklist</h2>
            <p className="text-muted-foreground">Production readiness checklist for go-live</p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              if (confirm("Reset all checklist items?")) {
                setCompletedItems(new Set());
              }
            }}
          >
            Reset All
          </Button>
        </div>

        {/* Progress Overview */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {allCriticalDone ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-yellow-500" />
                  )}
                  Launch Readiness
                </CardTitle>
                <CardDescription>
                  {completedCount} of {totalItems} items completed
                </CardDescription>
              </div>
              <div className="text-end">
                <div className="text-3xl font-bold">{Math.round(progressPercent)}%</div>
                <div className="text-sm text-muted-foreground">
                  {allCriticalDone ? (
                    <span className="text-green-600">Ready to launch!</span>
                  ) : (
                    <span className="text-yellow-600">{criticalItems.length - criticalCompleted} critical items remaining</span>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={progressPercent} className="h-3" />
            <div className="flex justify-between mt-2 text-sm text-muted-foreground">
              <span>Critical: {criticalCompleted}/{criticalItems.length}</span>
              <span>Total: {completedCount}/{totalItems}</span>
            </div>
          </CardContent>
        </Card>

        {/* Category Cards */}
        <div className="space-y-6">
          {CATEGORIES.map(category => {
            const categoryItems = CHECKLIST_ITEMS.filter(i => i.category === category.id);
            const categoryCompleted = categoryItems.filter(i => completedItems.has(i.id)).length;
            const CategoryIcon = category.icon;

            return (
              <Card key={category.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <CategoryIcon className={`h-5 w-5 ${category.color}`} />
                      {category.label}
                    </CardTitle>
                    <Badge variant="outline">
                      {categoryCompleted}/{categoryItems.length}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {categoryItems.map((item, index) => (
                      <div key={item.id}>
                        {index > 0 && <Separator className="my-3" />}
                        <div className="flex items-start gap-3">
                          <Checkbox
                            id={item.id}
                            checked={completedItems.has(item.id)}
                            onCheckedChange={() => toggleItem(item.id)}
                            className="mt-1"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <label
                                htmlFor={item.id}
                                className={`font-medium cursor-pointer ${
                                  completedItems.has(item.id) ? "line-through text-muted-foreground" : ""
                                }`}
                              >
                                {item.label}
                              </label>
                              {getPriorityBadge(item.priority)}
                            </div>
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {item.description}
                            </p>
                            {item.link && (
                              <a
                                href={item.link}
                                target={item.link.startsWith("http") ? "_blank" : undefined}
                                rel={item.link.startsWith("http") ? "noopener noreferrer" : undefined}
                                className="text-sm text-primary hover:underline inline-flex items-center gap-1 mt-1"
                              >
                                {item.linkLabel}
                                {item.link.startsWith("http") && <ExternalLink className="h-3 w-3" />}
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AdminLayout>
  );
}
