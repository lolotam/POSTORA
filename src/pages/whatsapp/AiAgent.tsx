import { Navigate, useParams } from "react-router-dom";
import { AI_AGENT_TABS, type AiAgentTab } from "@/components/messaging/AiAgentManager";

const UNIFIED_AGENT_SETTINGS = "/automation/agents?platform=whatsapp&surface=dms";

/**
 * Legacy WhatsApp AI agent settings now live in the Automation Hub's unified agent
 * portal. Kept as a route so old deep links (including /ai-agent/:tab) carry over
 * instead of 404ing; unknown tabs fall back to the portal's default.
 */
export default function AiAgent() {
  const { tab } = useParams<{ tab: string }>();
  const validTab = AI_AGENT_TABS.includes(tab as AiAgentTab) ? (tab as AiAgentTab) : null;
  return <Navigate to={validTab ? `${UNIFIED_AGENT_SETTINGS}&tab=${validTab}` : UNIFIED_AGENT_SETTINGS} replace />;
}
