import { ReactNode, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useUserRole } from "@/hooks/useUserRole";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, LayoutDashboard, Users, CreditCard, Package, Ticket, Settings, MessageSquare, ChevronLeft, Newspaper, Bell, Youtube, ScrollText, HeartPulse, BarChart3, Rocket, Gauge, Trash2, Sliders, Inbox, Activity, ToggleLeft, TrendingUp, KeyRound, Handshake } from "lucide-react";
import { cn } from "@/lib/utils";

interface AdminLayoutProps {
  children: ReactNode;
}

const sidebarItems = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/admin" },
  { icon: BarChart3, label: "Analytics", href: "/admin/analytics" },
  { icon: Activity, label: "Observability", href: "/admin/observability" },
  { icon: Users, label: "Users", href: "/admin/users" },
  { icon: CreditCard, label: "Subscriptions", href: "/admin/subscriptions" },
  { icon: Package, label: "Plans Builder", href: "/admin/plans" },
  { icon: Sliders, label: "Plan Quotas", href: "/admin/plan-quotas" },
  { icon: Ticket, label: "Coupons", href: "/admin/coupons" },
  { icon: Newspaper, label: "Blog Posts", href: "/admin/blog" },
  { icon: Bell, label: "Notifications", href: "/admin/notifications" },
  { icon: HeartPulse, label: "Token Health", href: "/admin/token-health" },
  { icon: ScrollText, label: "System Logs", href: "/admin/logs" },
  { icon: Youtube, label: "OAuth Verification", href: "/admin/oauth-verification" },
  { icon: KeyRound, label: "OAuth Apps", href: "/admin/oauth-apps" },
  { icon: Handshake, label: "Partner Hub", href: "/admin/partner-hub" },
  { icon: ToggleLeft, label: "Feature Flags", href: "/admin/feature-flags" },
  { icon: Settings, label: "Settings", href: "/admin/settings" },
  { icon: Inbox, label: "Email Inbox", href: "/admin/inbox" },
  { icon: MessageSquare, label: "Support Messages", href: "/admin/messages" },
  { icon: Gauge, label: "Rate Limits", href: "/admin/rate-limits" },
  { icon: Trash2, label: "Media Cleanup", href: "/admin/media-cleanup" },
  { icon: TrendingUp, label: "Scaling", href: "/admin/scaling" },
  { icon: Rocket, label: "Launch Checklist", href: "/admin/launch-checklist" },
];

export function AdminLayout({ children }: AdminLayoutProps) {
  const { isAdmin, isLoading: roleLoading } = useUserRole();
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!authLoading && !roleLoading) {
      if (!user) {
        navigate("/auth");
      } else if (!isAdmin) {
        navigate("/dashboard");
      }
    }
  }, [user, isAdmin, authLoading, roleLoading, navigate]);

  if (authLoading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-card flex flex-col">
        {/* Logo */}
        <div className="h-16 flex items-center px-6 border-b">
          <Link to="/" className="flex items-center">
            <Logo />
          </Link>
          <span className="ms-2 text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">
            Admin
          </span>
        </div>

        {/* Navigation */}
        <ScrollArea className="flex-1 py-4">
          <nav className="px-3 space-y-1">
            {sidebarItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <item.icon className="w-5 h-5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </ScrollArea>

        {/* Back to App */}
        <div className="p-4 border-t">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => navigate("/dashboard")}
          >
            <ChevronLeft className="w-4 h-4" />
            Back to App
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="h-16 border-b flex items-center justify-between px-6">
          <h1 className="text-lg font-semibold">
            {sidebarItems.find((item) => item.href === location.pathname)?.label || "Admin"}
          </h1>
          <div className="flex items-center gap-4">
            <ThemeToggle />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
