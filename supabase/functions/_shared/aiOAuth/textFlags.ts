import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const AI_TEXT_FLAG_KEYS = ["feature_ai_provider_oauth", "feature_ai_text_auth_lists", "feature_ai_category_text_ladders", "feature_ai_oauth_tools_claude", "feature_ai_oauth_tools_codex"] as const;
export type AiTextFlags = Record<typeof AI_TEXT_FLAG_KEYS[number], boolean>;

/** New readiness reads distinguish a configuration outage from a disabled flag.
 * The existing runtime master reader remains independent of list rollout. */
export async function readAiTextFlags(admin: SupabaseClient, signal = AbortSignal.timeout(10_000)): Promise<AiTextFlags> {
  const { data: rows, error } = await admin.from("system_settings").select("key,value")
    .in("key", [...AI_TEXT_FLAG_KEYS]).abortSignal(signal);
  if (error) {
    console.warn({ event: "ai_text_flags_read_failed", reason: "configuration_read_failed" });
    throw new Error("AI text configuration read failed");
  }
  return Object.fromEntries(AI_TEXT_FLAG_KEYS.map(key => [key, rows?.find(row => row.key === key)?.value === true])) as AiTextFlags;
}
