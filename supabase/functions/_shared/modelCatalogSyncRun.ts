import {
  type ExistingModelRow, type MappedCatalog, mapAnthropicCatalog, mapDeepSeekCatalog, mapGeminiCatalog,
  mapIdOnlyChatCatalog, mapOpenAICatalog, mapOpenRouterCatalog, mapVercelCatalog, mapXaiCatalog, planCatalogSync,
} from "./modelCatalogSync.ts";
import { resolveProviderKey } from "./providerKeys.ts";

export const SYNCABLE_PROVIDERS = [
  "vercel", "openrouter", "deepseek", "claude", "gemini", "openai", "zai", "minimax", "xai",
] as const;

export interface SyncReport {
  added: number;
  updated: number;
  deactivated: number;
  kept_in_use: string[];
  skipped_by_type: Record<string, number>;
  synced_at: string;
  dry_run: boolean;
}

/**
 * A sync refusal whose message is safe to show an admin: an upstream catalogue answer or a
 * configuration gap. Any other failure (database reads and writes) is logged, not shown.
 */
export class CatalogSyncError extends Error {
  override name = "CatalogSyncError";
}

const GENERIC_SYNC_FAILURE = "Model sync failed; see server logs";

/** The message the sync-models action returns for a failed sync. */
export function syncFailureMessage(err: unknown): string {
  return err instanceof CatalogSyncError ? err.message : GENERIC_SYNC_FAILURE;
}

interface CatalogueSource {
  /** Builds the request; `key` is null for public catalogues. */
  request(key: string | null): { url: string; headers: Record<string, string> };
  needsKey: boolean;
  list(body: unknown): unknown[];
  map(data: unknown[]): MappedCatalog;
}
const dataList = (body: unknown) => {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};
const bearer = (url: string): CatalogueSource["request"] => (key) => ({
  url,
  headers: key ? { Authorization: `Bearer ${key}` } : ({} as Record<string, string>),
});

const CATALOGUE: Record<string, CatalogueSource> = {
  vercel: { request: bearer("https://ai-gateway.vercel.sh/v1/models"), needsKey: false, list: dataList, map: mapVercelCatalog },
  openrouter: {
    request: bearer("https://openrouter.ai/api/v1/models?output_modalities=all"), needsKey: false, list: dataList,
    map: mapOpenRouterCatalog,
  },
  deepseek: { request: bearer("https://api.deepseek.com/models"), needsKey: true, list: dataList, map: mapDeepSeekCatalog },
  claude: {
    request: (key) => ({ url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } }),
    needsKey: true,
    list: dataList,
    map: mapAnthropicCatalog,
  },
  gemini: {
    request: (key) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key ?? "")}`,
      headers: {},
    }),
    needsKey: true,
    list: (body) => {
      const models = (body as { models?: unknown } | null)?.models;
      return Array.isArray(models) ? models : [];
    },
    map: mapGeminiCatalog,
  },
  openai: { request: bearer("https://api.openai.com/v1/models"), needsKey: true, list: dataList, map: mapOpenAICatalog },
  zai: { request: bearer("https://api.z.ai/api/paas/v4/models"), needsKey: true, list: dataList, map: mapIdOnlyChatCatalog },
  minimax: { request: bearer("https://api.minimax.io/v1/models"), needsKey: true, list: dataList, map: mapIdOnlyChatCatalog },
  xai: { request: bearer("https://api.x.ai/v1/models"), needsKey: true, list: dataList, map: mapXaiCatalog },
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

export async function runCatalogSync(
  db: CatalogDb,
  providerCode: string,
  fetchImpl: typeof fetch = fetch,
  options: { dryRun?: boolean } = {},
): Promise<SyncReport> {
  const source = CATALOGUE[providerCode];
  if (!source) throw new CatalogSyncError(`Provider ${providerCode} is not syncable`);
  const { data: providerRow, error: providerError } = await db.from("ai_providers")
    .select("id, provider_code, api_key_env_var").eq("provider_code", providerCode).maybeSingle();
  // A failed read must not read as "provider missing".
  if (providerError) throw new Error("ai_providers read failed");
  const provider = providerRow as { id: string; api_key_env_var: string } | null;
  if (!provider) throw new CatalogSyncError(`Provider ${providerCode} is missing`);

  let key: string | null = null;
  if (source.needsKey) {
    key = await resolveProviderKey(db, providerCode);
    if (!key) throw new CatalogSyncError(`API key ${provider.api_key_env_var} not configured`);
  }
  const { url, headers } = source.request(key);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch {
    // A rejected fetch (DNS, connection refused, TLS, abort) throws a TypeError whose message embeds the
    // request URL — for Gemini that URL carries the key. Never surface that message or chain it as `cause`;
    // a logger can serialise a cause just as readily as a top-level message.
    throw new CatalogSyncError(`${providerCode} /models request failed`);
  }
  // Never interpolate `url` into this message: the Gemini request carries the key in its query string.
  if (!res.ok) throw new CatalogSyncError(`${providerCode} /models returned HTTP ${res.status}`);
  const body = await res.json();
  const mapped = source.map(source.list(body));
  if (!mapped.models.length) throw new CatalogSyncError(`${providerCode} returned an empty model catalogue`);

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
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    if (rows.length) {
      const { error } = await db.from("ai_models").upsert(rows, { onConflict: "provider_id,model_id" });
      if (error) throw new Error(`ai_models upsert failed: ${error.message}`);
    }
    const { error: stampError } = await db.from("system_settings").upsert(
      { key: `model_catalog_synced_at_${providerCode}`, value: { at: now } }, { onConflict: "key" },
    );
    if (stampError) throw new Error(`system_settings write failed: ${stampError.message}`);
  }
  return {
    added: plan.inserts.length, updated: plan.updates.length, deactivated: plan.deactivateIds.length,
    kept_in_use: plan.keptInUse, skipped_by_type: mapped.skippedByType, synced_at: now, dry_run: dryRun,
  };
}
