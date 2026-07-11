import { Sparkles } from "lucide-react";
import { NavLink } from "react-router-dom";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { whatsappAutomationTabs, whatsappSectionRoute } from "@/components/whatsapp/waNav";
import { cn } from "@/lib/utils";

// UI-only hub that groups Automation sub-features. Each tab links to its
// existing WhatsApp sub-route so no backend/logic changes are needed.
export default function Automation() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Sparkles}
        title="Automation"
        description="AI agent, quick replies, auto replies, broadcasting, agents, and human handoff."
      />

      <nav
        aria-label="Automation sub-sections"
        className="flex flex-wrap gap-2 rounded-lg border bg-card p-2"
      >
        {whatsappAutomationTabs.map((tab) => {
          const Icon = tab.icon;
          const target = tab.path === "human-agent"
            ? whatsappSectionRoute("agents")
            : whatsappSectionRoute(tab.path);
          return (
            <NavLink
              key={tab.path}
              to={target}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </NavLink>
          );
        })}
      </nav>

      <p className="text-sm text-muted-foreground">
        Choose a sub-section above to configure it.
      </p>
    </div>
  );
}

