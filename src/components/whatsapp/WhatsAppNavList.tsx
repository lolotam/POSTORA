import { useTranslation } from "react-i18next";
import "@/i18n";
import { NavLink } from "react-router-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { whatsappNavItems, whatsappSectionRoute } from "./waNav";

function navLabel(path: string, fallback: string, t: (key: string, fallback: string) => string) {
  switch (path) {
    case "": return t("nav.dashboard", "Dashboard");
    case "pipelines": return t("nav.pipelines", "Pipelines");
    case "conversations": return t("nav.conversations", "Conversations");
    case "contacts": return t("nav.contacts", "Contacts");
    case "templates": return t("nav.templates", "Templates");
    case "analytics": return t("nav.analytics", "Analytics");
    case "quick-replies": return t("nav.quick-replies", "Quick Replies");
    case "broadcasts": return t("nav.broadcasts", "Broadcasting");
    case "agents": return t("nav.agents", "Agents");
    case "profile": return t("nav.profile", "Profile");
    case "scheduled": return t("nav.scheduled", "Scheduled");
    case "response-stats": return t("nav.response-stats", "Response Stats");
    case "catalog": return t("nav.catalog", "Catalog");
    case "setup": return t("nav.setup", "Setup");
    case "docs": return t("nav.docs", "Docs");
    default: return fallback;
  }
}

interface WhatsAppNavListProps {
  /** Icons-only rail. Labels move into tooltips so the section is still identifiable. */
  collapsed?: boolean;
  /** Lets the mobile drawer close itself once navigation happens. */
  onNavigate?: () => void;
}

export function WhatsAppNavList({ collapsed = false, onNavigate }: WhatsAppNavListProps) {
  const { t } = useTranslation("whatsapp");

  return (
    <nav aria-label={t("header.navAria", "WhatsApp sections")} className="flex flex-col gap-1">
      {whatsappNavItems.map((item) => {
        const Icon = item.icon;
        const label = navLabel(item.path, item.label, t);
        const link = (
          <NavLink
            key={item.path || "dashboard"}
            to={whatsappSectionRoute(item.path)}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#128C7E] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                collapsed ? "mx-auto h-10 w-10 justify-center rounded-xl p-0" : "px-3 py-2.5",
                isActive
                  ? "bg-[#128C7E] text-white shadow-sm shadow-[#128C7E]/20"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")} aria-hidden="true" />
            <span className={cn(collapsed && "sr-only")}>{label}</span>
          </NavLink>
        );

        if (!collapsed) return link;

        return (
          <Tooltip key={item.path || "dashboard"} delayDuration={0}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
