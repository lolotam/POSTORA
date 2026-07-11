import { Sparkles } from "lucide-react";
import { AiAgentManager } from "@/components/messaging/AiAgentManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function AiAgent() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Sparkles}
        title="AI Agent"
        description="Configure the AI assistant that answers customers automatically."
      />
      <AiAgentManager />
    </div>
  );
}