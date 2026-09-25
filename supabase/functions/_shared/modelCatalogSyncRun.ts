import {
  type ExistingModelRow, type MappedCatalog, mapDeepSeekCatalog, mapOpenRouterCatalog, mapVercelCatalog, planCatalogSync,
} from "./modelCatalogSync.ts";
import { resolveProviderKey } from "./providerKeys.ts";

export const SYNCABLE_PROVIDERS = ["vercel", "openrouter", "deepseek"] as const;

export interface SyncReport {
  added: number;
  updated: number;
  deactivated: number;
  kept_in_use: string[];
  skipped_by_type: Record<string, number>;
  synced_at: string;
}

const CATALOGUE: Record<string, { url: string; needsKey: boolean; map: (d: unknown[]) => MappedCatalog }> = {
  vercel: { url: "https://ai-gateway.vercel.sh/v1/models", needsKey: false, map: mapVercelCatalog },
  openrouter: { url: "https://openrouter.ai/api/v1/models", needsKey: false, map: mapOpenRouterCatalog },
  deepseek: { url: "https://api.deepseek.com/models", needsKey: true, map: mapDeepSeekCatalog },
};

type DbError = { message: string } | null;
type DbResult = { data: unknown; error: DbError };
interface CatalogQuery extends PromiseLike<DbResult> {
  eq(column: string, value: string): CatalogQuery;
  like(column: string, pattern: string): CatalogQuery;
  maybeSingle(): PromiseLike<DbResult>;
}
/** The slice of a service-role Supabase client the sync uses. */
export interface CatalogDb {
  from(table: string): {
    select(columns: string): CatalogQuery;
    upsert(values: unknown, options: { onConflict: string }): PromiseLike<{ error: DbError }>;
  };
}

const MODEL_COLUMNS =
  "id, model_id, name, description, is_active, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, metadata";

function defaultModelsInUse(settings: Array<{ value: unknown }>, providerCode: string): Set<string> {
  const inUse = new Set<string>();
  for (const s of settings) {
    let v: unknown = s.value;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        continue; // A malformed setting names no model; skip it rather than abort the sync.
      }
    }
    const setting = v as { provider_code?: unknown; model_id?: unknown } | null;
    if (setting?.provider_code === providerCode && typeof setting.model_id === "string" && setting.model_id) {
      inUse.add(setting.model_id);
    }
  }
  return inUse;
}

export async function runCatalogSync(db: CatalogDb, providerCode: string, fetchImpl: typeof fetch = fetch): Promise<SyncReport> {
  const source = CATALOGUE[providerCode];
  if (!source) throw new Error(`Provider ${providerCode} is not syncable`);
  const { data: providerRow } = await db.from("ai_providers")
    .select("id, provider_code, api_key_env_var").eq("provider_code", providerCode).maybeSingle();
  const provider = providerRow as { id: string; api_key_env_var: string } | null;
  if (!provider) throw new Error(`Provider ${providerCode} is missing`);

  const headers: Record<string, string> = {};
  if (source.needsKey) {
    const key = await resolveProviderKey(db, providerCode);
    if (!key) throw new Error(`API key ${provider.api_key_env_var} not configured`);
    headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${providerCode} /models returned HTTP ${res.status}`);
  const body = await res.json();
  const mapped = source.map(Array.isArray(body?.data) ? body.data : []);
  if (!mapped.models.length) throw new Error(`${providerCode} returned an empty model catalogue`);

  const { data: existingData, error: existingError } = await db.from("ai_models")
    .select(MODEL_COLUMNS).eq("provider_id", provider.id);
  if (existingError) throw new Error("ai_models read failed");
  const existing = (existingData ?? []) as ExistingModelRow[];
  const { data: settings, error: settingsError } = await db.from("system_settings")
    .select("key, value").like("key", "default_ai_model%");
  if (settingsError) throw new Error("system_settings read failed");
  const inUse = defaultModelsInUse((settings ?? []) as Array<{ value: unknown }>, providerCode);

  const plan = planCatalogSync(existing, mapped, inUse);
  const now = new Date().toISOString();
  // Every row carries the same columns: a PostgREST bulk upsert nulls any a row omits.
  // admin_params is deliberately absent so the upsert never touches it.
  const row = (m: Omit<ExistingModelRow, "id">) => ({
    provider_id: provider.id, model_id: m.model_id, name: m.name, description: m.description,
    capabilities: m.capabilities, context_limit: m.context_limit,
    cost_per_1m_input_tokens: m.cost_per_1m_input_tokens, cost_per_1m_output_tokens: m.cost_per_1m_output_tokens,
    metadata: m.metadata, is_active: m.is_active, updated_at: now,
  });
  const deactivated = existing.filter((r) => plan.deactivateIds.includes(r.id));
  const rows = [
    ...plan.inserts.map((m) => row({ ...m, is_active: true })),
    ...plan.updates.map((u) => row(u)),
    ...deactivated.map((r) => row({ ...r, is_active: false, metadata: { ...(r.metadata ?? {}), sync_deactivated: true } })),
  ];
  if (rows.length) {
    const { error } = await db.from("ai_models").upsert(rows, { onConflict: "provider_id,model_id" });
    if (error) throw new Error(`ai_models upsert failed: ${error.message}`);
  }
  const { error: stampError } = await db.from("system_settings").upsert(
    { key: `model_catalog_synced_at_${providerCode}`, value: { at: now } }, { onConflict: "key" },
  );
  if (stampError) throw new Error(`system_settings write failed: ${stampError.message}`);
  return {
    added: plan.inserts.length, updated: plan.updates.length, deactivated: plan.deactivateIds.length,
    kept_in_use: plan.keptInUse, skipped_by_type: mapped.skippedByType, synced_at: now,
  };
}
