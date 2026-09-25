import { supabase } from "@/integrations/supabase/client";
import { type AgentDashboard, type ModelPrice, parseAgentDashboard } from "../domain/agentDashboard";

/**
 * Supabase adapters for the AI Agent dashboard.
 *
 * The aggregate is one RPC call (SECURITY INVOKER, scoped to auth.uid()) so the browser
 * receives a few hundred bytes of totals instead of every ai_agent_logs row in the window.
 */
export async function fetchAgentDashboard(days: number, platform: string | null): Promise<AgentDashboard> {
  const { data, error } = await supabase.rpc("ai_agent_dashboard", { p_days: days, p_platform: platform });
  if (error) throw error;
  return parseAgentDashboard(data);
}

/**
 * The public model catalogue's prices (ai_models is readable by every signed-in user).
 * Rows without a price are left out: they cannot contribute to an estimate.
 */
export async function fetchModelPrices(): Promise<ModelPrice[]> {
  const { data, error } = await supabase
    .from("ai_models")
    .select("model_id, cost_per_1m_input_tokens, cost_per_1m_output_tokens")
    .not("cost_per_1m_input_tokens", "is", null)
    .not("cost_per_1m_output_tokens", "is", null);
  if (error) throw error;
  return data ?? [];
}
