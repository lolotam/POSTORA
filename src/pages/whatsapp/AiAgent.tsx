import { Sparkles } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { AI_AGENT_TABS, AiAgentManager, type AiAgentTab } from "@/components/messaging/AiAgentManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { WhatsAppAutomationNav } from "@/components/whatsapp/WhatsAppAutomationNav";
import { WHATSAPP_BASE_PATH } from "@/components/whatsapp/waNav";

export default function AiAgent() {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const activeTab: AiAgentTab = AI_AGENT_TABS.includes(tab as AiAgentTab) ? (tab as AiAgentTab) : "settings";

  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Sparkles}
        title="AI Agent"
        description="Configure the AI assistant that answers customers automatically."
      />
      <WhatsAppAutomationNav />
      <AiAgentManager
        activeTab={activeTab}
        onTabChange={(nextTab) =>
          navigate(nextTab === "settings" ? `${WHATSAPP_BASE_PATH}/ai-agent` : `${WHATSAPP_BASE_PATH}/ai-agent/${nextTab}`, { replace: true })
        }
      />
    </div>
  );
}
