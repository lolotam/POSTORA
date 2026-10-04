import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useScheduledPostCount } from "@/hooks/usePosts";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useSubscription } from "@/hooks/useSubscription";
import { usePublishing } from "@/contexts/PublishingContext";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { NotificationBell } from "@/components/NotificationBell";
import { CreditBalanceIndicator } from "@/components/CreditBalanceIndicator";
import { PublishingStatusWidget } from "@/components/PublishingStatusWidget";
import {
  LayoutDashboard,
  Send,
  Users,
  Clock,
  Settings,
  LogOut,
  Menu,
  X,
  Loader2,
  FolderOpen,
  BarChart3,
  CalendarDays,
  FileText,
  Activity,
  ChevronDown,
  Key,
  BookOpen,
  Mail,
  Shield,
  Crown,
  Zap,
  PenTool,
  EyeOff,
  Facebook,
  Camera,
  AtSign,
  Video,
  MessageSquare,
  MessageCircle,
  Bot,
  Sparkles,
  Headphones,
  ShoppingBag,
  Megaphone,
  Inbox, 
  Workflow,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";

interface DashboardLayoutProps {
  children: React.ReactNode;
  contentClassName?: string;
  noPadding?: boolean;
  hideFooter?: boolean;
}

// Nav item types
interface NavItemDirect {
  type: "link";
  icon: typeof LayoutDashboard;
  label: string;
  path: string;
  external?: boolean;
}

interface NavItemDropdown {
  type: "dropdown";
  icon: typeof LayoutDashboard;
  label: string;
  basePath: string;
  children: { icon: typeof LayoutDashboard; label: string; path: string }[];
}

type NavEntry = NavItemDirect | NavItemDropdown;

function ScheduledCountBadge({
  count,
  unavailable,
  label,
  className,
}: {
  count: number | undefined;
  unavailable: boolean;
  label: string;
  className?: string;
}) {
  if (unavailable) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={label}
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground",
                className,
              )}
            >
              !
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">{label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (count === undefined || count <= 0) return null;

  return (
    <span className={cn("font-mono text-[11px] tabular-nums text-muted-foreground", className)}>
      {count}
    </span>
  );
}

export function DashboardLayout({ children, contentClassName, noPadding = false, hideFooter = false }: DashboardLayoutProps) {
  const { t } = useTranslation("nav");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // Explicit open/closed choices per nav group; a group nobody has toggled falls back to
  // its default (Publishing, and whichever group holds the current page, start open).
  const [groupToggles, setGroupToggles] = useState<Record<string, boolean>>({});
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut, profile } = useAuth();
  const { isAdmin } = useUserRole();
  const { planName, isPro, isBusiness, isFree } = useSubscription();
  const { publishingPosts, isPublishing } = usePublishing();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const scheduledQuery = useScheduledPostCount();
  const scheduledCount = scheduledQuery.data;
  const scheduledCountUnavailable = scheduledQuery.isError && scheduledCount === undefined;
  const scheduledCountLabel = t("badge.scheduledCountUnavailable", "Couldn't load the scheduled count");

  const showCanvas = isAdmin || (!flagsLoading && flags.canvas);

  // User dropdown menu items
  const userMenuItems = useMemo(() => [
    ...(!isAdmin ? [{ icon: Zap, label: t("userMenu.aiCredits", "AI Credits"), path: "/credits" }] : []),
    { icon: BarChart3, label: t("userMenu.postAnalytics", "Post Analytics"), path: "/analytics" },
    { icon: FileText, label: t("userMenu.templates", "Templates"), path: "/templates" },
    { icon: FolderOpen, label: t("userMenu.mediaLibrary", "Media Library"), path: "/media" },
    { icon: Key, label: t("userMenu.mcpApi", "MCP & API"), path: "/api-keys" },
    { icon: Activity, label: t("userMenu.health", "Health"), path: "/connection-health" },
    ...(isAdmin ? [{ icon: BookOpen, label: t("userMenu.systemLogs", "System Logs"), path: "/admin/logs" }] : []),
    { icon: Mail, label: t("userMenu.contactUs", "Contact Us"), path: "/contact" },
  ], [isAdmin, t]);

  // Build nav entries
  const navEntries = useMemo(() => {
    const entries: NavEntry[] = [
      { type: "link", icon: LayoutDashboard, label: t("sidebar.dashboard", "Dashboard"), path: "/dashboard" },
      {
        type: "dropdown",
        icon: Send,
        label: t("sidebar.publishing", "Publishing"),
        basePath: "/post",
        children: [
          { icon: Send, label: t("sidebar.createPost", "Create Post"), path: "/post" },
          { icon: Clock, label: t("sidebar.history", "History"), path: "/history" },
          { icon: CalendarDays, label: t("sidebar.scheduled", "Scheduled"), path: "/scheduled" },
          { icon: CalendarDays, label: t("sidebar.calendar", "Calendar"), path: "/calendar" },
          ...(flags.smartScheduling ? [{ icon: Sparkles, label: t("sidebar.smartSchedule", "Smart Schedule"), path: "/smart-scheduling" }] : []),
          ...(showCanvas ? [{ icon: PenTool, label: t("sidebar.canvas", "Canvas"), path: "/canvas" }] : []),
        ],
      },
      { type: "link", icon: Users, label: t("sidebar.users", "Users"), path: "/profiles" },
    ];

    const analyticsChildren = [
      ...(flags.analyticsFacebook ? [{ icon: Facebook, label: t("sidebar.facebook", "Facebook"), path: "/analytics/facebook" }] : []),
      ...(flags.analyticsInstagram ? [{ icon: Camera, label: t("sidebar.instagram", "Instagram"), path: "/analytics/instagram" }] : []),
      ...(flags.analyticsThreads ? [{ icon: AtSign, label: t("sidebar.threads", "Threads"), path: "/analytics/threads" }] : []),
      ...(flags.analyticsTiktok ? [{ icon: Video, label: t("sidebar.tiktok", "TikTok"), path: "/analytics/tiktok" }] : []),
    ];

    if (analyticsChildren.length > 0) {
      entries.push({
        type: "dropdown",
        icon: BarChart3,
        label: t("sidebar.analytics", "Analytics"),
        basePath: "/analytics/",
        children: analyticsChildren,
      });
    }

    const hasMessagingFlags = flags.msgWhatsapp || flags.msgFacebook || flags.msgInstagram || flags.msgThreads;

    const automationChildren = [
      { icon: Sparkles, label: t("sidebar.overview", "Overview"), path: "/automation" },
      { icon: Bot, label: t("sidebar.agentSetup", "Agent Setup"), path: "/automation/agents" },
      // Sits beside Agent Setup deliberately: this is the human half of the same
      // conversation pipeline the AI agent handles. It lived under Ad Manager until
      // 2026-09-08, which put a live support queue next to advertising tools.
      ...(flags.humanAgent ? [{ icon: Headphones, label: t("sidebar.humanAgent", "Human Agent"), path: "/human-agent" }] : []),
      ...(hasMessagingFlags ? [{ icon: Inbox, label: t("sidebar.unifiedInboxes", "Unified Inboxes"), path: "/messaging" }] : []),
      ...(flags.commentManager ? [{ icon: MessageCircle, label: t("sidebar.commentManager", "Comment Manager"), path: "/comments" }] : []),
      ...(flags.audienceHub ? [{ icon: Users, label: t("sidebar.audienceContacts", "Audience & Contacts"), path: "/automation/audience" }] : []),
      ...(flags.commentWorkflow ? [{ icon: Workflow, label: t("sidebar.commentWorkflow", "Comment Workflow"), path: "/automation/comment-workflow" }] : []),
    ];

    entries.push({
      type: "dropdown",
      icon: Sparkles,
      label: t("sidebar.automation", "Automation"),
      basePath: "/automation",
      children: automationChildren,
    });

    const adManagerChildren = [
      ...(flags.adManager ? [{ icon: Megaphone, label: t("sidebar.adManager", "Ad Manager"), path: "/ad-manager" }] : []),
      ...(flags.adAnalytics ? [{ icon: BarChart3, label: t("sidebar.adAnalytics", "Ad Analytics"), path: "/ad-analytics" }] : []),
      ...(flags.leadsCrm ? [{ icon: Users, label: t("sidebar.leadsCrm", "Leads CRM"), path: "/leads-crm" }] : []),
      ...(flags.whatsappShop ? [{ icon: ShoppingBag, label: t("sidebar.whatsappShop", "WhatsApp Shop"), path: "/whatsapp-shop" }] : []),
    ];

    if (adManagerChildren.length > 0) {
      entries.push({
        type: "dropdown",
        icon: Megaphone,
        label: t("sidebar.adManager", "Ad Manager"),
        basePath: "/ad-",
        children: adManagerChildren,
      });
    }

    entries.push(
      { type: "link", icon: BookOpen, label: t("sidebar.docs", "Docs"), path: "https://postora.cloud/docs", external: true },
      { type: "link", icon: BarChart3, label: t("sidebar.pricing", "Pricing"), path: "/pricing" },
    );

    if (import.meta.env.DEV) {
      console.debug("[sidebar] analytics children", analyticsChildren.map((c) => c.label));
      console.debug("[sidebar] ad children", adManagerChildren.map((c) => c.label));
    }

    return entries;
  }, [showCanvas, flags.msgFacebook, flags.msgInstagram, flags.msgWhatsapp, flags.msgThreads, flags.commentManager, flags.commentWorkflow, flags.audienceHub, flags.leadsCrm, flags.adAnalytics, flags.smartScheduling, flags.humanAgent, flags.whatsappShop, flags.adManager, flags.analyticsFacebook, flags.analyticsInstagram, flags.analyticsThreads, flags.analyticsTiktok, t]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await signOut();
    navigate("/");
  };

  const userInitials = profile?.full_name
    ? profile.full_name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : profile?.email?.slice(0, 2).toUpperCase() || "U";

  const isDropdownActive = (entry: NavItemDropdown) =>
    entry.children.some((c) => location.pathname === c.path || (c.path.includes("?") && (location.pathname + location.search) === c.path)) ||
    location.pathname.startsWith(entry.basePath);

  const isCanvasHiddenFromUsers = (path: string) => path === "/canvas" && isAdmin && !flags.canvas;

  const isGroupOpen = (entry: NavItemDropdown) =>
    groupToggles[entry.basePath] ?? (entry.basePath === "/post" || isDropdownActive(entry));

  const toggleGroup = (entry: NavItemDropdown) =>
    setGroupToggles((prev) => ({ ...prev, [entry.basePath]: !isGroupOpen(entry) }));

  const isChildActive = (path: string) =>
    location.pathname === path || (path.includes("?") && (location.pathname + location.search) === path);

  const itemClass = (active: boolean) =>
    cn(
      "flex items-center gap-2.5 min-h-9 px-2.5 rounded-lg text-sm font-medium transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
    );

  const hiddenBadge = (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ms-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-400 cursor-help">
            <EyeOff className="h-2.5 w-2.5" />
            {t("badge.hidden", "Hidden")}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[200px]">
          <p className="text-xs">{t("badge.hiddenTooltip", "This feature is currently disabled globally. Only admins can see it.")}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  // One nav tree, rendered in the desktop sidebar and in the mobile panel.
  const renderNav = (onNavigate?: () => void) => (
    <div className="flex flex-col gap-1">
      {navEntries.map((entry) => {
        if (entry.type === "link") {
          if (entry.external) {
            return (
              <a
                key={entry.path}
                href={entry.path}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onNavigate}
                className={itemClass(false)}
              >
                <entry.icon className="h-4 w-4 shrink-0" />
                <span>{entry.label}</span>
              </a>
            );
          }
          const active = location.pathname === entry.path;
          return (
            <Link
              key={entry.path}
              to={entry.path}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(itemClass(active), isCanvasHiddenFromUsers(entry.path) && "border border-dashed border-amber-500/50")}
            >
              <entry.icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{entry.label}</span>
              {isCanvasHiddenFromUsers(entry.path) && hiddenBadge}
            </Link>
          );
        }

        const open = isGroupOpen(entry);
        return (
          <div key={entry.basePath} className="flex flex-col gap-0.5 pt-2">
            <button
              type="button"
              onClick={() => toggleGroup(entry)}
              aria-expanded={open}
              className="flex items-center gap-2 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors text-start"
            >
              <span className="flex-1">{entry.label}</span>
              {!open && entry.basePath === "/post" && (
                <ScheduledCountBadge count={scheduledCount} unavailable={scheduledCountUnavailable} label={scheduledCountLabel} />
              )}
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90 rtl:rotate-90")} />
            </button>
            {open &&
              entry.children.map((child) => {
                const active = isChildActive(child.path);
                const hidden = isCanvasHiddenFromUsers(child.path);
                return (
                  <Link
                    key={child.path}
                    to={child.path}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(itemClass(active), hidden && "border border-dashed border-amber-500/50")}
                  >
                    <child.icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{child.label}</span>
                    {hidden && hiddenBadge}
                    {child.path === "/scheduled" && (
                      <ScheduledCountBadge count={scheduledCount} unavailable={scheduledCountUnavailable} label={scheduledCountLabel} />
                    )}
                  </Link>
                );
              })}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar — first in DOM, so it sits at the inline start: left in English, right in Arabic. */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-e border-sidebar-border bg-sidebar sticky top-0 h-screen">
        <Link to="/" className="flex items-center h-14 px-4 shrink-0">
          <Logo size="sm" showText />
        </Link>
        <nav aria-label={t("sidebar.main", "Main")} className="flex-1 overflow-y-auto px-3 pb-4">
          {renderNav()}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="app-topnav sticky top-0 z-40 border-b border-border bg-background">
          <div className="flex h-14 items-center gap-2 px-3 md:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden h-9 w-9"
              aria-label={mobileMenuOpen ? t("header.closeMenu", "Close menu") : t("header.openMenu", "Open menu")}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
            <Link to="/" className="lg:hidden flex items-center">
              <Logo size="sm" showText={false} />
            </Link>

            <div className="flex items-center gap-1.5 md:gap-2 ms-auto">
              <PublishingStatusWidget publishingPosts={publishingPosts} isPublishing={isPublishing} />
              <CreditBalanceIndicator />
              <NotificationBell />
              <ThemeToggle />
              <LanguageToggle />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="flex items-center gap-2 h-9 px-2 rounded-full">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={profile?.avatar_url || ""} alt={profile?.full_name || t("header.user", "User")} referrerPolicy="no-referrer" />
                      <AvatarFallback className="text-xs bg-secondary text-secondary-foreground font-semibold">{userInitials}</AvatarFallback>
                    </Avatar>
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden md:block" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={profile?.avatar_url || ""} alt={profile?.full_name || t("header.user", "User")} referrerPolicy="no-referrer" />
                        <AvatarFallback className="text-sm bg-secondary text-secondary-foreground font-semibold">{userInitials}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col space-y-1">
                        <p className="text-sm font-medium">{profile?.full_name || t("header.user", "User")}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[140px]">{profile?.email}</p>
                        <Badge
                          variant={isAdmin || isPro || isBusiness ? "secondary" : "destructive"}
                          className={cn("text-[10px] px-1.5 py-0 h-4 w-fit font-semibold", !isAdmin && isFree && "cursor-pointer hover:bg-destructive/90")}
                          onClick={!isAdmin && isFree ? () => navigate("/pricing") : undefined}
                        >
                          {isAdmin && <Shield className="h-2.5 w-2.5 me-0.5" />}
                          {!isAdmin && (isPro || isBusiness) && <Crown className="h-2.5 w-2.5 me-0.5" />}
                          {isAdmin ? t("badge.admin", "Admin") : (isFree ? t("badge.upgrade", "Upgrade") : planName)}
                        </Badge>
                      </div>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {userMenuItems.map((item) => (
                    <DropdownMenuItem key={item.path} asChild>
                      <Link to={item.path} className="flex items-center gap-2 cursor-pointer">
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/settings" className="flex items-center gap-2 cursor-pointer">
                      <Settings className="h-4 w-4" />
                      {t("userMenu.settings", "Settings")}
                    </Link>
                  </DropdownMenuItem>
                  {isAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link to="/admin" className="flex items-center gap-2 cursor-pointer">
                          <Shield className="h-4 w-4" />
                          {t("userMenu.adminDashboard", "Admin Dashboard")}
                        </Link>
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogout} disabled={isLoggingOut} className="text-destructive focus:text-destructive cursor-pointer">
                    {isLoggingOut ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <LogOut className="h-4 w-4 me-2" />}
                    {t("userMenu.logout", "Logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Mobile navigation: the same tree as the sidebar, plus the account links. */}
          {mobileMenuOpen && (
            <nav aria-label={t("sidebar.main", "Main")} className="lg:hidden border-t border-border bg-background max-h-[75vh] overflow-y-auto p-3">
              {renderNav(() => setMobileMenuOpen(false))}
              <div className="border-t border-border mt-3 pt-3 flex flex-col gap-1">
                <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{t("sidebar.account", "Account")}</p>
                {[...userMenuItems, { icon: Settings, label: t("userMenu.settings", "Settings"), path: "/settings" }].map((item) => (
                  <Link key={item.path} to={item.path} onClick={() => setMobileMenuOpen(false)} className={itemClass(location.pathname === item.path)}>
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                ))}
              </div>
            </nav>
          )}
        </header>

        <main className="app-main flex-1 flex flex-col">
          <div className={cn(noPadding ? "w-full flex-1 flex flex-col p-0" : "p-4 md:p-6 lg:p-8 2xl:p-10 w-full max-w-7xl mx-auto", contentClassName)}>
            {children}
          </div>
        </main>

        {!hideFooter && (
          <footer className="border-t border-border">
            <div className="px-6 py-6 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                <a href="https://postora.cloud/docs" target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t("footer.documentation", "Documentation")}
                </a>
                <a href="https://postora.cloud/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t("footer.privacyPolicy", "Privacy Policy")}
                </a>
                <a href="https://postora.cloud/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t("footer.termsOfService", "Terms of Service")}
                </a>
                <a href="https://postora.cloud/cookies" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t("footer.cookiePolicy", "Cookie Policy")}
                </a>
                <a href="https://postora.cloud/google-api-disclosure" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t("footer.googleApiDisclosure", "Google API Disclosure")}
                </a>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {t("footer.copyright", "© 2026 Postora. A product developed and operated by WALEED PROLIFE LLC. All rights reserved.")}
              </p>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
