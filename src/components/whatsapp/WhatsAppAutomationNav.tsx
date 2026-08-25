import { NavLink } from "react-router-dom";
import { type AutomationTabItem, whatsappAutomationTabs, whatsappSectionRoute } from "@/components/whatsapp/waNav";
import { cn } from "@/lib/utils";

/**
 * Sub-sections reachable from every automation page. Sourced from `whatsappAutomationTabs` so this
 * bar and the sidebar's Automation highlight (WhatsAppNavList) can never disagree about which
 * routes belong to the hub. Absolute tabs (Human Agent) live outside /messaging/whatsapp and keep
 * their own top-level nav entry, so they are not repeated here.
 */
const automationNavTabs: AutomationTabItem[] = whatsappAutomationTabs.filter((tab) => !tab.absolute);

export function WhatsAppAutomationNav({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Automation sub-sections"
      className={cn("flex flex-wrap gap-2 rounded-lg border bg-card p-2 shadow-sm", className)}
    >
      {automationNavTabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.path}
            to={whatsappSectionRoute(tab.path)}
            // No `end`: NavLink prefix-matches descendants, so /ai-agent/:tab keeps AI Agent active.
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
