import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { groupCatalogueRows, type CatalogueRow } from "../_shared/aiModelCatalogue.ts";

export async function readCatalogue(admin: SupabaseClient) {
  const catalogue: Array<CatalogueRow & Record<string, unknown>> = [];
  const signal = AbortSignal.timeout(10_000);
  for (;;) {
    const page = await admin.from('ai_models')
      .select('*, ai_providers(provider_code, name)').order('name').order('id')
      .range(catalogue.length, catalogue.length + 499).abortSignal(signal)
      .then(({ data, error }) => ({ ...groupCatalogueRows(data ?? []), error }));
    if (page.error) throw new Error('The model catalogue could not be read');
    const rows = [...page.models, ...page.oauthModels];
    if (!rows.length) return { ...groupCatalogueRows(catalogue), error: null };
    catalogue.push(...rows);
  }
}
