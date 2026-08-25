import { Sparkles } from "lucide-react";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { WhatsAppAutomationNav } from "@/components/whatsapp/WhatsAppAutomationNav";

// UI-only hub that groups Automation sub-features. Each tab links to its
// existing WhatsApp sub-route so no backend/logic changes are needed.
export default function Automation() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Sparkles}
        title="Automation"
        description="AI agent, quick replies, auto replies, broadcasting, and team agents."
      />

      <WhatsAppAutomationNav />

      <p className="text-sm text-muted-foreground">
        Choose a sub-section above to configure it.
      </p>
    </div>
  );
}

