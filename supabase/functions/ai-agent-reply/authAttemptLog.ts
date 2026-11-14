import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { raceSignal } from "../_shared/aiOAuth/piCall.ts";

/** Only operational fields cross this boundary; no native transcript or payload. */
export async function logAgentAuthEvent(admin: SupabaseClient, userId: string, metadata: {
  code: string; provider?: string; model?: string; level?: number; attempt?: number; duration_ms?: number;
  auth_method?: "api_key" | "oauth"; prompt_tokens?: number; completion_tokens?: number;
}, remainingMs: number): Promise<void> {
  if (remainingMs <= 0) { console.warn({ event: "ai_agent_auth_log_deadline", code: metadata.code }); return; }
  const signal = AbortSignal.timeout(Math.max(1, Math.min(250, remainingMs)));
  try {
    const { error } = await raceSignal(admin.from("system_logs").insert({
      level: metadata.code === "oauth_completion_selected" ? "info" : "warn", category: "ai", source: "ai-agent-reply", message: "Agent subscription attempt", user_id: userId,
      metadata: { auth_method: "oauth", ...metadata },
    }).abortSignal(signal), signal);
    if (error) throw new Error();
  } catch { console.warn({ event: "ai_agent_auth_log_failed", code: metadata.code }); }
}
