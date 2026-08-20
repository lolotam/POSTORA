import { useAIConfiguration } from "@/hooks/useAIConfiguration";
import type { AIModel, DefaultModel } from "@/hooks/ai-config/types";
import type { ResolvedTier } from "@/components/ai/ResolvedModelCards";

/**
 * Turn the three configured tiers into displayable rows, in the order the
 * server will try them.
 *
 * A tier pointing at a model that is no longer in the catalog is dropped rather
 * than shown, so the cards never name a model that cannot run. That happens
 * routinely: sync_models deactivates models the provider has withdrawn, while
 * the setting still names them.
 */
export function resolveTiers(
  models: AIModel[],
  tiers: { primary: DefaultModel | null; fallback: DefaultModel | null; fallback2: DefaultModel | null },
): ResolvedTier[] {
  const out: ResolvedTier[] = [];
  for (const tier of [tiers.primary, tiers.fallback, tiers.fallback2]) {
    if (!tier) continue;
    const row = models.find(
      (m) => m.model_id === tier.model_id && m.ai_providers?.provider_code === tier.provider_code,
    );
    if (!row) continue;
    out.push({ provider_code: tier.provider_code, model_id: tier.model_id, name: row.name });
  }
  return out;
}

/** The image models a generation will try, in order. Display only. */
export function useResolvedImageModels(): { tiers: ResolvedTier[]; isLoading: boolean } {
  const { data, isLoading } = useAIConfiguration();
  if (!data) return { tiers: [], isLoading };
  return {
    tiers: resolveTiers(data.models, {
      primary: data.categoryDefaults.image,
      fallback: data.categoryFallbacks.image,
      fallback2: data.categoryFallbacks2.image,
    }),
    isLoading,
  };
}
