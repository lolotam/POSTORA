import { ReactNode, useEffect, useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useUserRole } from "@/hooks/useUserRole";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useDirection } from "@radix-ui/react-direction";
import { PanelLeftClose, PanelLeftOpen, PanelLeft, Menu, Loader2, LayoutDashboard, Users, CreditCard, Package, Ticket, Settings, MessageSquare, ChevronLeft, Newspaper, Bell, Youtube, ScrollText, HeartPulse, BarChart3, Rocket, Gauge, Trash2, Sliders, Inbox, Activity, ToggleLeft, TrendingUp, KeyRound, Handshake } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Three widths, not a boolean. "expanded" and "icons" both keep the rail on
 * screen; "hidden" gives the page its full width, which is what the wide admin
 * tables and the inbox actually need. Persisted because an admin who collapsed
 * the rail meant it for the session, not for one route change.
 */
type SidebarState = "expanded" | "icons" | "hidden";

const SIDEBAR_STORAGE_KEY = "postora.admin.sidebar";

function readStoredSidebarState(): SidebarState {
  // Wrapped: a private window or blocked site data throws on access rather
  // than returning null, and that must not take the whole admin down.
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "expanded" || stored === "icons" || stored === "hidden") return stored;
  } catch {
    /* fall through to the default */
  }
  return "expanded";
}

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

  const [sidebar, setSidebar] = useState<SidebarState>(readStoredSidebarState);
  // Below lg the rail would eat most of a phone screen, so the same nav opens
  // as a drawer instead and the persisted desktop state is left alone.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The drawer slides in from the edge the rail lives on: left in English, right in Arabic.
  const drawerSide = useDirection() === "rtl" ? "right" : "left";

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebar);
    } catch {
      /* a viewer with site data blocked simply does not get persistence */
    }
  }, [sidebar]);

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

  const renderNav = (compact: boolean) => (
    <nav className={cn("space-y-1", compact ? "px-2" : "px-3")}>
      {sidebarItems.map((item) => {
        const isActive = location.pathname === item.href;
        const link = (
          <Link
            to={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center rounded-lg text-sm font-medium transition-colors",
              compact ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <item.icon className="w-5 h-5 shrink-0" />
            {!compact && item.label}
          </Link>
        );
        // Collapsed to icons the label is the only thing identifying a
        // destination, so it has to survive as a tooltip.
        return compact ? (
          <TooltipProvider key={item.href} delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <div key={item.href}>{link}</div>
        );
      })}
    </nav>
  );

  const renderSidebarBody = (compact: boolean) => (
    <>
      {/* Logo */}
      <div className={cn("h-14 lg:h-16 flex items-center border-b shrink-0", compact ? "justify-center px-2" : "px-6")}>
        <Link to="/" className="flex items-center">
          <Logo showText={!compact} />
        </Link>
        {!compact && (
          <span className="ms-2 text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">
            Admin
          </span>
        )}
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 py-4">{renderNav(compact)}</ScrollArea>

      {/* Back to App */}
      <div className={cn("border-t shrink-0", compact ? "p-2" : "p-4")}>
        <Button
          variant="ghost"
          className={cn("w-full gap-2", compact ? "justify-center px-0" : "justify-start")}
          onClick={() => navigate("/dashboard")}
          title={compact ? "Back to App" : undefined}
        >
          <ChevronLeft className="w-4 h-4 rtl-flip shrink-0" />
          {!compact && "Back to App"}
        </Button>
      </div>
    </>
  );

  return (
    // h-dvh rather than h-screen: on mobile browsers 100vh includes the area
    // under the collapsing URL bar, which would hide the bottom of <main>.
    <div className="h-screen h-dvh flex bg-background overflow-hidden">
      {/* Sidebar — full height and shrink-0 so the rail runs the full height of
          the viewport and the page scrolls inside <main> rather than behind it.
          Desktop only; phones and tablets get the drawer below. */}
      {sidebar !== "hidden" && (
        <aside
          className={cn(
            "hidden lg:flex border-e bg-card flex-col h-full shrink-0 transition-[width] duration-200",
            sidebar === "icons" ? "w-16" : "w-64"
          )}
        >
          {renderSidebarBody(sidebar === "icons")}
        </aside>
      )}

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side={drawerSide} className="lg:hidden w-72 max-w-[85vw] p-0 flex flex-col gap-0 bg-card">
          <SheetTitle className="sr-only">Admin navigation</SheetTitle>
          {renderSidebarBody(false)}
        </SheetContent>
      </Sheet>

      {/* Main Content — min-w-0 so a wide admin table scrolls inside <main>
          instead of stretching the flex row and pushing the rail off screen. */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Header */}
        <header className="h-14 lg:h-16 border-b flex items-center justify-between gap-2 px-3 sm:px-4 lg:px-6 shrink-0">
          <div className="flex items-center gap-2 lg:gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden shrink-0"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open admin navigation"
              aria-expanded={mobileNavOpen}
            >
              <Menu className="w-5 h-5" />
            </Button>
            {/* The only way back when the rail is hidden, so it lives in the
                header rather than in the sidebar it controls. */}
            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:inline-flex shrink-0"
              onClick={() =>
                setSidebar((current) =>
                  current === "expanded" ? "icons" : current === "icons" ? "hidden" : "expanded"
                )
              }
              aria-label={
                sidebar === "expanded"
                  ? "Collapse sidebar to icons"
                  : sidebar === "icons"
                    ? "Hide sidebar"
                    : "Show sidebar"
              }
              title={
                sidebar === "expanded"
                  ? "Collapse to icons"
                  : sidebar === "icons"
                    ? "Hide sidebar"
                    : "Show sidebar"
              }
            >
              {sidebar === "expanded" ? (
                <PanelLeftClose className="w-5 h-5 rtl-flip" />
              ) : sidebar === "icons" ? (
                <PanelLeft className="w-5 h-5 rtl-flip" />
              ) : (
                <PanelLeftOpen className="w-5 h-5 rtl-flip" />
              )}
            </Button>
            <h1 className="text-base lg:text-lg font-semibold truncate">
              {sidebarItems.find((item) => item.href === location.pathname)?.label || "Admin"}
            </h1>
          </div>
          <div className="flex items-center gap-2 lg:gap-4 shrink-0">
            <ThemeToggle />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-3 sm:p-4 lg:p-6 overflow-auto min-h-0 overscroll-contain">
          {children}
        </main>
      </div>
    </div>
  );
}
