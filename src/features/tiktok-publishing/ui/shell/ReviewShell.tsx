import { useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleCheckBig,
  LogOut,
  Menu,
  Plug,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/Logo";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import { usePipelineCounts } from "./usePipelineCounts";
import "./reviewShell.css";

interface NavEntry {
  label: string;
  path: string;
  icon: LucideIcon;
  count?: number;
  countLabel?: string;
}

interface ReviewShellProps {
  children: ReactNode;
  /** Pages that manage their own padding (e.g. full-height editors). */
  fill?: boolean;
}

export function ReviewShell({ children, fill = false }: ReviewShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const counts = usePipelineCounts();

  const groups: { label: string; items: NavEntry[] }[] = [
    {
      label: "Pipeline",
      items: [
        { label: "Activity", path: REVIEW_PATHS.activity, icon: Activity },
        {
          label: "Calendar",
          path: REVIEW_PATHS.calendar,
          icon: CalendarDays,
          count: counts.failed,
          countLabel: `${counts.failed} failed to publish`,
        },
        {
          label: "Approvals",
          path: REVIEW_PATHS.approvals,
          icon: CircleCheckBig,
          count: counts.pending,
          countLabel: `${counts.pending} waiting for approval`,
        },
      ],
    },
    {
      label: "Settings",
      items: [
        { label: "Workspace", path: REVIEW_PATHS.workspace, icon: Settings },
        { label: "Integrations", path: REVIEW_PATHS.integrations, icon: Plug },
      ],
    },
  ];

  return (
    <div className="rs-shell" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <aside className="rs-sidebar" aria-label="Main navigation" onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) setMobileOpen(false);
      }}>
        <Link to={REVIEW_PATHS.approvals} className="rs-brand" aria-label="Postora home">
          <Logo size="sm" showText={!collapsed} animate={false} />
        </Link>
        <button
          type="button"
          className="rs-collapse"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>

        <nav className="rs-nav">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <span className="rs-nav-label rs-hide-collapsed">{group.label}</span>
              {group.items.map((item) => <SidebarLink key={item.path} item={item} collapsed={collapsed} />)}
            </div>
          ))}
        </nav>

        <SidebarFooter collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="rs-mobile-bar">
          <button type="button" className="rs-btn rs-btn-ghost rs-btn-round" aria-label="Open navigation menu" onClick={() => setMobileOpen(true)}>
            <Menu />
          </button>
          <Logo size="sm" animate={false} />
        </div>
        <main className="rs-main" data-fill={fill}>{children}</main>
      </div>
      {mobileOpen ? <button type="button" aria-label="Close navigation menu" className="fixed inset-0 z-40 cursor-default bg-transparent md:hidden" onClick={() => setMobileOpen(false)} /> : null}
    </div>
  );
}

function SidebarLink({ item, collapsed }: { item: NavEntry; collapsed: boolean }) {
  const location = useLocation();
  const active = location.pathname === item.path;
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      className="rs-nav-item"
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
    >
      <Icon aria-hidden="true" />
      <span className="rs-nav-text rs-hide-collapsed">{item.label}</span>
      {item.count ? (
        <span className="rs-count" aria-label={item.countLabel}>{item.count}</span>
      ) : null}
    </NavLink>
  );
}

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const { profile, signOut } = useAuth();
  const { planName } = useSubscription();
  const navigate = useNavigate();
  const name = profile?.full_name || profile?.email?.split("@")[0] || "Account";
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="rs-footer">
      {!collapsed ? (
        <div className="rs-plan-card">
          <div className="min-w-0">
            <div className="rs-plan-eyebrow">Plan</div>
            <div className="rs-plan-name">{planName}</div>
          </div>
          <Link to={REVIEW_PATHS.pricing} className="rs-btn rs-btn-ink rs-btn-sm" aria-label="Upgrade subscription">
            Upgrade
          </Link>
        </div>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="rs-user" aria-label="User menu">
            <span className="rs-avatar">
              {profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initial}
            </span>
            <span className="min-w-0 flex-1 rs-hide-collapsed">
              <span className="rs-user-name block">{name}</span>
              <span className="rs-user-email block">{profile?.email}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-[color:var(--rs-ink-mute)] rs-hide-collapsed" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <span className="rs-label block">Signed in as</span>
            <span className="mt-1 block text-sm font-semibold">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{profile?.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate(REVIEW_PATHS.workspace)}>
            <UserRound className="mr-2 h-4 w-4" />
            Account settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void signOut().then(() => navigate("/"));
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
