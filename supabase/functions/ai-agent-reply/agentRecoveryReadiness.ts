import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AiTier } from "../_shared/ai-fallback.ts";
import { hasLaterAgentApiTier, supportsAgentApiTools } from "../_shared/agentRecovery.ts";

/** No new tiers are inserted. Only later admin-chosen platform APIs qualify. */
export async function agentRecoveryReady(admin: SupabaseClient, chain: AiTier[], index: number, signal: AbortSignal): Promise<boolean> {
  const ready = new Set<AiTier>();
  for (const tier of chain.slice(index + 1)) {
    if (tier.credentialSource !== "platform" || tier.authMethod === "oauth") continue;
    const { data: provider, error } = await admin.from("ai_providers").select("id,is_active").eq("provider_code", tier.provider).abortSignal(signal).maybeSingle();
    if (error) throw new Error("oauth_configuration_read_failed");
    if (!provider?.is_active) continue;
    const { data: model, error: modelError } = await admin.from("ai_models").select("capabilities,metadata,is_active")
      .eq("provider_id", provider.id).eq("model_id", tier.model).eq("auth_method", "api_key").abortSignal(signal).maybeSingle();
    if (modelError) throw new Error("oauth_configuration_read_failed");
    if (!model?.is_active || !supportsAgentApiTools(model)) continue;
    ready.add(tier);
  }
  return hasLaterAgentApiTier(chain, index, tier => ready.has(tier));
}
