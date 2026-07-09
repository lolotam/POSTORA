import { UserCog } from "lucide-react";
import { AgentManager } from "@/components/messaging/AgentManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Agents() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={UserCog}
        title="Agents"
        description="Assign WhatsApp conversations and manage human handoff."
      />
      <AgentManager />
    </div>
  );
}
