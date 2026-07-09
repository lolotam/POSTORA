import { useState, useMemo } from "react";
import { usePosts } from "@/hooks/usePosts";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useSubscription } from "@/hooks/useSubscription";
import { usePublishing } from "@/contexts/PublishingContext";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ThemeToggle";
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
  Sparkles,
  Headphones,
  ShoppingBag,
  Megaphone,
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

// User dropdown menu items
const getUserMenuItems = (isAdmin: boolean) => [
  ...(!isAdmin ? [{ icon: Zap, label: "AI Credits", path: "/credits" }] : []),
  { icon: BarChart3, label: "Post Analytics", path: "/analytics" },
  { icon: FileText, label: "Templates", path: "/templates" },
  { icon: FolderOpen, label: "Media Library", path: "/media" },
  { icon: Key, label: "API Keys", path: "/api-keys" },
  { icon: Activity, label: "Health", path: "/connection-health" },
  ...(isAdmin ? [{ icon: BookOpen, label: "System Logs", path: "/admin/logs" }] : []),
  { icon: Mail, label: "Contact Us", path: "/contact" },
];

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [mobileExpandedDropdown, setMobileExpandedDropdown] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut, profile } = useAuth();
  const { isAdmin } = useUserRole();
  const { planName, isPro, isBusiness, isFree } = useSubscription();
  const { publishingPosts, isPublishing } = usePublishing();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { data: allPosts = [] } = usePosts();
  const scheduledCount = useMemo(() =>
    allPosts.filter(p => p.scheduled_at && new Date(p.scheduled_at) > new Date() && (p.status === "pending" || p.status === "scheduled")).length,
    [allPosts]
  );

  const showCanvas = isAdmin || (!flagsLoading && flags.canvas);

  // Build nav entries
  const navEntries = useMemo(() => {
    const entries: NavEntry[] = [
      { type: "link", icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
      {
        type: "dropdown",
        icon: Send,
        label: "Publishing",
        basePath: "/post",
        children: [
          { icon: Send, label: "Create Post", path: "/post" },
          { icon: Clock, label: "History", path: "/history" },
          { icon: CalendarDays, label: "Scheduled", path: "/scheduled" },
          { icon: CalendarDays, label: "Calendar", path: "/calendar" },
          ...(flags.smartScheduling ? [{ icon: Sparkles, label: "Smart Schedule", path: "/smart-scheduling" }] : []),
        ],
      },
      { type: "link", icon: Users, label: "Users", path: "/profiles" },
    ];

    if (showCanvas) {
      entries.push({ type: "link", icon: PenTool, label: "Canvas", path: "/canvas" });
    }

    const analyticsChildren = [
      ...(flags.analyticsFacebook ? [{ icon: Facebook, label: "Facebook", path: "/analytics/facebook" }] : []),
      ...(flags.analyticsInstagram ? [{ icon: Camera, label: "Instagram", path: "/analytics/instagram" }] : []),
      ...(flags.analyticsThreads ? [{ icon: AtSign, label: "Threads", path: "/analytics/threads" }] : []),
      ...(flags.analyticsTiktok ? [{ icon: Video, label: "TikTok", path: "/analytics/tiktok" }] : []),
    ];

    if (analyticsChildren.length > 0) {
      entries.push({
        type: "dropdown",
        icon: BarChart3,
        label: "Analytics",
        basePath: "/analytics/",
        children: analyticsChildren,
      });
    }

    const messagingChildren = [
      ...(flags.msgFacebook ? [{ icon: Facebook, label: "Facebook", path: "/messaging/facebook" }] : []),
      ...(flags.msgInstagram ? [{ icon: Camera, label: "Instagram", path: "/messaging/instagram" }] : []),
      ...(flags.msgThreads ? [{ icon: AtSign, label: "Threads", path: "/messaging/thread" }] : []),
      ...(flags.msgWhatsapp ? [
        { icon: MessageSquare, label: "WhatsApp", path: "/messaging/whatsapp" },
      ] : []),
    ];

    if (messagingChildren.length > 0) {
      entries.push({
        type: "dropdown",
        icon: MessageSquare,
        label: "Messaging",
        basePath: "/messaging/",
        children: messagingChildren,
      });
    }

    const adManagerChildren = [
      ...(flags.adManager ? [{ icon: Megaphone, label: "Ad Manager", path: "/ad-manager" }] : []),
      ...(flags.adAnalytics ? [{ icon: BarChart3, label: "Ad Analytics", path: "/ad-analytics" }] : []),
      ...(flags.leadsCrm ? [{ icon: Users, label: "Leads CRM", path: "/leads-crm" }] : []),
      ...(flags.humanAgent ? [{ icon: Headphones, label: "Human Agent", path: "/human-agent" }] : []),
      ...(flags.whatsappShop ? [{ icon: ShoppingBag, label: "WhatsApp Shop", path: "/whatsapp-shop" }] : []),
    ];

    if (adManagerChildren.length > 0) {
      entries.push({
        type: "dropdown",
        icon: Megaphone,
        label: "Ad Manager",
        basePath: "/ad-",
        children: adManagerChildren,
      });
    }

    entries.push(
      { type: "link", icon: BookOpen, label: "Docs", path: "https://postora.cloud/docs", external: true },
      { type: "link", icon: BarChart3, label: "Pricing", path: "/pricing" },
    );

    if (import.meta.env.DEV) {
      console.debug("[sidebar] analytics children", analyticsChildren.map((c) => c.label));
      console.debug("[sidebar] ad children", adManagerChildren.map((c) => c.label));
    }

    return entries;
  }, [showCanvas, flags.msgFacebook, flags.msgInstagram, flags.msgWhatsapp, flags.msgThreads, flags.commentManager, flags.leadsCrm, flags.adAnalytics, flags.smartScheduling, flags.humanAgent, flags.whatsappShop, flags.adManager, flags.analyticsFacebook, flags.analyticsInstagram, flags.analyticsThreads, flags.analyticsTiktok, flagsLoading]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await signOut();
    navigate("/");
  };

  const userInitials = profile?.full_name
    ? profile.full_name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : profile?.email?.slice(0, 2).toUpperCase() || "U";

  const isDropdownActive = (entry: NavItemDropdown) =>
    entry.children.some((c) => location.pathname === c.path) || location.pathname.startsWith(entry.basePath);

  const isCanvasHiddenFromUsers = (path: string) => path === "/canvas" && isAdmin && !flags.canvas;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Header Navigation */}
      <header className="app-topnav sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="flex h-14 md:h-16 items-center px-3 md:px-6 max-w-[1800px] mx-auto w-full">
          {/* Logo */}
          <Link to="/" className="flex items-center mr-4 md:mr-8 shrink-0">
            <Logo size="sm" showText className="hidden sm:flex" />
            <Logo size="sm" showText={false} className="sm:hidden" />
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden lg:flex items-center justify-center gap-0.5 flex-1 relative">
            {navEntries.map((entry) => {
              if (entry.type === "link") {
                const item = entry;
                const isActive = !item.external && location.pathname === item.path;
                const canvasHidden = isCanvasHiddenFromUsers(item.path);

                if (item.external) {
                  return (
                    <motion.a
                      key={item.path}
                      href={item.path}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-200 whitespace-nowrap text-muted-foreground hover:text-foreground"
                      whileHover={{ scale: 1.05, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </motion.a>
                  );
                }

                return (
                  <motion.div
                    key={item.path}
                    whileHover={{ scale: 1.05, y: -2 }}
                    whileTap={{ scale: 0.98 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  >
                    <Link
                      to={item.path}
                      className={cn(
                        "relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-200 whitespace-nowrap z-10",
                        isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
                        canvasHidden && "border border-dashed border-amber-500/50"
                      )}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="nav-pill"
                          className="absolute inset-0 rounded-lg bg-primary/10 shadow-[0_0_20px_-5px_hsl(var(--primary)/0.5)]"
                          transition={{ type: "spring", stiffness: 380, damping: 30 }}
                        >
                          <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5" />
                          <motion.div
                            className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent rounded-full"
                            initial={{ width: "0%" }}
                            animate={{ width: "60%" }}
                            transition={{ delay: 0.1, duration: 0.3 }}
                          />
                        </motion.div>
                      )}
                      <span className="relative z-10"><item.icon className={cn("h-4 w-4 shrink-0", isActive && "text-primary")} /></span>
                      <span className="relative z-10">{item.label}</span>
                      {item.path === "/scheduled" && scheduledCount > 0 && (
                        <span className="relative z-10 ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1">
                          {scheduledCount}
                        </span>
                      )}
                      {canvasHidden && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="relative z-10 flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-600 dark:text-amber-400 cursor-help">
                                <EyeOff className="h-2.5 w-2.5" />
                                Hidden
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-[200px]">
                              <p className="text-xs">This feature is currently disabled globally. Only admins can see it.</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </Link>
                  </motion.div>
                );
              }

              // Dropdown entry
              const dropdown = entry;
              const active = isDropdownActive(dropdown);

              return (
                <DropdownMenu key={dropdown.label}>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-200 whitespace-nowrap outline-none",
                        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {active && (
                        <motion.div
                          layoutId="nav-pill"
                          className="absolute inset-0 rounded-lg bg-primary/10 shadow-[0_0_20px_-5px_hsl(var(--primary)/0.5)]"
                          transition={{ type: "spring", stiffness: 380, damping: 30 }}
                        >
                          <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5" />
                          <motion.div
                            className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent rounded-full"
                            initial={{ width: "0%" }}
                            animate={{ width: "60%" }}
                            transition={{ delay: 0.1, duration: 0.3 }}
                          />
                        </motion.div>
                      )}
                      <span className="relative z-10"><dropdown.icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} /></span>
                      <span className="relative z-10">{dropdown.label}</span>
                      <ChevronDown className="relative z-10 h-3 w-3 ml-0.5 opacity-60" />
                      {dropdown.label === "Publishing" && scheduledCount > 0 && (
                        <span className="relative z-10 ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1">
                          {scheduledCount}
                        </span>
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-48">
                    {dropdown.children.map((child) => {
                      const childActive = location.pathname === child.path;
                      return (
                        <DropdownMenuItem key={child.path} asChild>
                          <Link
                            to={child.path}
                            className={cn(
                              "flex items-center gap-2 cursor-pointer",
                              childActive && "text-primary font-semibold"
                            )}
                          >
                            <child.icon className="h-4 w-4" />
                            {child.label}
                            {child.path === "/scheduled" && scheduledCount > 0 && (
                              <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1">
                                {scheduledCount}
                              </span>
                            )}
                          </Link>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            })}
          </nav>

          {/* Right Side Actions */}
          <div className="flex items-center gap-1.5 md:gap-2 ml-auto">
            <PublishingStatusWidget
              publishingPosts={publishingPosts}
              isPublishing={isPublishing}
            />
            <CreditBalanceIndicator />
            <NotificationBell />
            <ThemeToggle />

            {/* User Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex items-center gap-2 h-9 px-2 rounded-full">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={profile?.avatar_url || ""} alt={profile?.full_name || "User"} referrerPolicy="no-referrer" />
                    <AvatarFallback className="text-xs bg-primary/10 text-primary font-semibold">
                      {userInitials}
                    </AvatarFallback>
                  </Avatar>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden md:block" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-background border-border">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={profile?.avatar_url || ""} alt={profile?.full_name || "User"} referrerPolicy="no-referrer" />
                      <AvatarFallback className="text-sm bg-primary/10 text-primary font-semibold">
                        {userInitials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col space-y-1">
                      <p className="text-sm font-medium">{profile?.full_name || "User"}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-[140px]">
                        {profile?.email}
                      </p>
                      <Badge 
                        variant={isAdmin ? "default" : (isPro || isBusiness ? "default" : "destructive")}
                        className={cn(
                          "text-[10px] px-1.5 py-0 h-4 w-fit font-semibold",
                          isAdmin && "bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white border-0",
                          !isAdmin && (isPro || isBusiness) && "bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0",
                          !isAdmin && isFree && "cursor-pointer hover:bg-destructive/90"
                        )}
                        onClick={!isAdmin && isFree ? () => navigate("/pricing") : undefined}
                      >
                        {isAdmin && <Shield className="h-2.5 w-2.5 mr-0.5" />}
                        {!isAdmin && (isPro || isBusiness) && <Crown className="h-2.5 w-2.5 mr-0.5" />}
                        {isAdmin ? "Admin" : (isFree ? "Upgrade" : planName)}
                      </Badge>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {getUserMenuItems(isAdmin).map((item) => (
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
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {isAdmin && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin" className="flex items-center gap-2 cursor-pointer text-primary">
                      <Shield className="h-4 w-4" />
                      Admin Dashboard
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="text-destructive focus:text-destructive cursor-pointer"
                >
                  {isLoggingOut ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <LogOut className="h-4 w-4 mr-2" />
                  )}
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Mobile Menu Button */}
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden h-9 w-9"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="lg:hidden border-t border-border bg-background/95 backdrop-blur-xl overflow-hidden"
            >
              <nav className="p-3 space-y-1 max-h-[70vh] overflow-y-auto">
                {navEntries.map((entry, index) => {
                  if (entry.type === "link") {
                    const item = entry;
                    const isActive = !item.external && location.pathname === item.path;
                    const canvasHidden = isCanvasHiddenFromUsers(item.path);

                    if (item.external) {
                      return (
                        <motion.a
                          key={item.path}
                          href={item.path}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setMobileMenuOpen(false)}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.05, duration: 0.3 }}
                          className="flex items-center gap-3 px-4 py-3 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
                        >
                          <item.icon className="h-5 w-5" />
                          <span className="font-medium">{item.label}</span>
                        </motion.a>
                      );
                    }

                    return (
                      <motion.div
                        key={item.path}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.05, duration: 0.3 }}
                      >
                        <Link
                          to={item.path}
                          onClick={() => setMobileMenuOpen(false)}
                          className={cn(
                            "flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-200",
                            isActive
                              ? "bg-primary/10 text-primary shadow-[0_0_15px_-3px_hsl(var(--primary)/0.3)]"
                              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                            canvasHidden && "border border-dashed border-amber-500/50"
                          )}
                        >
                          <item.icon className="h-5 w-5" />
                          <span className="font-medium">{item.label}</span>
                        </Link>
                      </motion.div>
                    );
                  }

                  // Dropdown in mobile = expandable section
                  const dropdown = entry;
                  const active = isDropdownActive(dropdown);
                  const expanded = mobileExpandedDropdown === dropdown.label;

                  return (
                    <motion.div
                      key={dropdown.label}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05, duration: 0.3 }}
                    >
                      <button
                        onClick={() => setMobileExpandedDropdown(expanded ? null : dropdown.label)}
                        className={cn(
                          "flex items-center gap-3 px-4 py-3 rounded-lg transition-colors duration-200 w-full text-left",
                          active
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                        )}
                      >
                        <dropdown.icon className="h-5 w-5" />
                        <span className="font-medium flex-1">{dropdown.label}</span>
                        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
                      </button>
                      <AnimatePresence>
                        {expanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="pl-8 space-y-0.5 py-1">
                              {dropdown.children.map((child) => {
                                const childActive = location.pathname === child.path;
                                return (
                                  <Link
                                    key={child.path}
                                    to={child.path}
                                    onClick={() => setMobileMenuOpen(false)}
                                    className={cn(
                                      "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors",
                                      childActive
                                        ? "text-primary font-semibold bg-primary/5"
                                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                                    )}
                                  >
                                    <child.icon className="h-4 w-4" />
                                    <span>{child.label}</span>
                                  </Link>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: navEntries.length * 0.05 + 0.1 }}
                  className="border-t border-border my-2 pt-2"
                >
                  <p className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Account</p>
                  {getUserMenuItems(isAdmin).map((item, idx) => (
                    <motion.div
                      key={item.path}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: (navEntries.length + idx + 1) * 0.05, duration: 0.3 }}
                    >
                      <Link
                        to={item.path}
                        onClick={() => setMobileMenuOpen(false)}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
                      >
                        <item.icon className="h-5 w-5" />
                        <span className="font-medium">{item.label}</span>
                      </Link>
                    </motion.div>
                  ))}
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: (navEntries.length + getUserMenuItems(isAdmin).length + 1) * 0.05, duration: 0.3 }}
                  >
                    <Link
                      to="/settings"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center gap-3 px-4 py-3 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
                    >
                      <Settings className="h-5 w-5" />
                      <span className="font-medium">Settings</span>
                    </Link>
                  </motion.div>
                </motion.div>
              </nav>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Main Content */}
      <main className="app-main flex-1 overflow-auto">
        <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto w-full">{children}</div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-card/50">
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
    </div>
  );
}
