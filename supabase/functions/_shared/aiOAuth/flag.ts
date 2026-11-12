import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const FLAG_KEY = "feature_ai_provider_oauth";

/**
 * The subscription-OAuth feature flag. Strictly the JSON boolean `true` turns
 * it on; absent row, string "true", or false all mean OFF. The migration seeds
 * false and production must stay off unless the owner accepts the account and
 * terms risk (spec §1).
 */
export async function isAiProviderOAuthEnabled(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", FLAG_KEY)
    .maybeSingle();
  if (error || !data) return false;
  return data.value === true;
}
