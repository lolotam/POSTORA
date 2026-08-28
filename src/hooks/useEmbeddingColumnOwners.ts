import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { recordedEmbeddingWidth } from "@/hooks/ai-config/embeddingDimensions";
import type { AIModel } from "@/hooks/ai-config/types";

/** Which model produced the vectors currently stored in each vector column. */
export type EmbeddingColumnOwners = Record<string, { provider_code: string; model_id: string }>;

const OWNER_KEY_PREFIX = "embedding_column_owner_";

export function embeddingColumnForWidth(width: number): string {
  return width === 1024 ? "embedding_bge_m3" : "embedding";
}

/**
 * Reads the recorded owner of each vector column from system_settings.
 *
 * Embeddings are only comparable within one model, so a column filled by model A
 * cannot be searched with queries embedded by model B — retrieval degrades to
 * noise silently, with nothing failing. The edge function refuses such a switch;
 * this lets the admin UI say so *before* the save instead of after.
 */
export function useEmbeddingColumnOwners() {
  return useQuery({
    queryKey: ["embedding-column-owners"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings" as never)
        .select("key, value")
        .like("key", `${OWNER_KEY_PREFIX}%`);
      if (error) throw error;
      const owners: EmbeddingColumnOwners = {};
      for (const row of (data || []) as Array<{ key: string; value: unknown }>) {
        const column = row.key.slice(OWNER_KEY_PREFIX.length);
        const value = row.value as { provider_code?: unknown; model_id?: unknown } | null;
        if (typeof value?.provider_code === "string" && typeof value?.model_id === "string") {
          owners[column] = { provider_code: value.provider_code, model_id: value.model_id };
        }
      }
      return owners;
    },
  });
}

/**
 * The warning to show before saving `selection`, or null when the choice is
 * safe. Safe means: the column has no recorded owner yet (nothing to
 * invalidate), or the selection IS the current owner.
 */
export function reEmbedWarningFor(
  selection: { provider_code: string; model_id: string },
  models: AIModel[],
  owners: EmbeddingColumnOwners,
  providers: Array<{ id: string; provider_code: string }>,
): string | null {
  // AIModel carries provider_id, so the provider has to be resolved rather than
  // compared directly. Matching on model_id alone would be wrong the day two
  // providers expose the same slug.
  const providerId = providers.find((p) => p.provider_code === selection.provider_code)?.id;
  const row = models.find(
    (model) => model.model_id === selection.model_id && model.provider_id === providerId,
  );
  const width = recordedEmbeddingWidth(row?.metadata);
  if (width === null) return null;

  const owner = owners[embeddingColumnForWidth(width)];
  if (!owner) return null;
  if (owner.provider_code === selection.provider_code && owner.model_id === selection.model_id) {
    return null;
  }

  return (
    `Vectors in this column were produced by ${owner.provider_code}/${owner.model_id}. ` +
    `Embeddings from different models are not comparable, so switching to ` +
    `${selection.provider_code}/${selection.model_id} makes the existing knowledge base unsearchable ` +
    `until every source is re-ingested. Same dimension does not mean compatible.`
  );
}
