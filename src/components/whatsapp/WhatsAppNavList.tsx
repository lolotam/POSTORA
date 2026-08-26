import { NavLink, useLocation } from "react-router-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { whatsappAutomationTabs, whatsappNavItems, whatsappSectionRoute } from "./waNav";

// Sub-sections grouped under the Automation hub keep its nav entry highlighted.
const automationSubRoutes = whatsappAutomationTabs
  .filter((tab) => !tab.absolute)
  .map((tab) => whatsappSectionRoute(tab.path));

interface WhatsAppNavListProps {
  /** Icons-only rail. Labels move into tooltips so the section is still identifiable. */
  collapsed?: boolean;
  /** Lets the mobile drawer close itself once navigation happens. */
  onNavigate?: () => void;
}

export function WhatsAppNavList({ collapsed = false, onNavigate }: WhatsAppNavListProps) {
  const { pathname } = useLocation();
  const onAutomationSubRoute = automationSubRoutes.some((route) => pathname.startsWith(route));

  return (
    <nav aria-label="WhatsApp sections" className="flex flex-col gap-1">
      {whatsappNavItems.map((item) => {
        const Icon = item.icon;
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
                isActive || (item.path === "automation" && onAutomationSubRoute)
                  ? "bg-[#128C7E] text-white shadow-sm shadow-[#128C7E]/20"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")} aria-hidden="true" />
            <span className={cn(collapsed && "sr-only")}>{item.label}</span>
          </NavLink>
        );

        if (!collapsed) return link;

        return (
          <Tooltip key={item.path || "dashboard"} delayDuration={0}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
