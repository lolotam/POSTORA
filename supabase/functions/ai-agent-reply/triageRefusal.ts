import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { TRIAGE_SETTING_KEYS, type TriageRun, type TriageTier } from "../_shared/agentTriage.ts";

/** Best effort within the shared deadline: logging must not fail the normal Agent reply. */
export async function persistTriageRefusals(admin: Pick<SupabaseClient, "from">, triage: TriageRun, chain: TriageTier[], deadlineAt: number): Promise<void> {
  console.warn({ event: "agent_triage_refused", attempts: triage.errors });
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(100, remaining)));
  const attempts = triage.errors.map((failure, index) => {
    const configurationSlot = TRIAGE_SETTING_KEYS.indexOf(failure.model) - 1;
    return { ...failure, provider: chain[index]?.provider, auth_method: chain[index]?.authMethod ?? "api_key",
      slot: ["primary", "fallback", "fallback_2"][configurationSlot >= 0 ? configurationSlot : index] };
  });
  try {
    const { error } = await admin.from("system_logs").insert({ level: "warn", category: "ai", source: "ai-agent-reply",
      message: "Triage refused; normal Agent fallback retained", metadata: { attempts } }).abortSignal(signal);
    if (error) console.warn({ event: "agent_triage_refusal_log_failed" });
  } catch { console.warn({ event: "agent_triage_refusal_log_failed" }); }
}
