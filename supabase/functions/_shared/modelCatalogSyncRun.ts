// deno-lint-ignore-file no-explicit-any
import {
  type MappedCatalog, mapDeepSeekCatalog, mapOpenRouterCatalog, mapVercelCatalog, planCatalogSync,
} from "./modelCatalogSync.ts";

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

async function providerKey(db: any, provider: { provider_code: string; api_key_env_var: string }) {
  const fromEnv = Deno.env.get(provider.api_key_env_var);
  if (fromEnv) return fromEnv;
  const { data } = await db.from("provider_api_keys").select("api_key")
    .eq("provider_code", provider.provider_code).maybeSingle();
  return data?.api_key ?? null;
}

export async function runCatalogSync(db: any, providerCode: string, fetchImpl: typeof fetch = fetch): Promise<SyncReport> {
  const source = CATALOGUE[providerCode];
  if (!source) throw new Error(`Provider ${providerCode} is not syncable`);
  const { data: provider } = await db.from("ai_providers")
    .select("id, provider_code, api_key_env_var").eq("provider_code", providerCode).maybeSingle();
  if (!provider) throw new Error(`Provider ${providerCode} is missing`);

  const headers: Record<string, string> = {};
  if (source.needsKey) {
    const key = await providerKey(db, provider);
    if (!key) throw new Error(`API key ${provider.api_key_env_var} not configured`);
    headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${providerCode} /models returned HTTP ${res.status}`);
  const body = await res.json();
  const mapped = source.map(Array.isArray(body?.data) ? body.data : []);
  if (!mapped.models.length) throw new Error(`${providerCode} returned an empty model catalogue`);

  const { data: existing, error: existingError } = await db.from("ai_models")
    .select("id, model_id, is_active, capabilities, metadata").eq("provider_id", provider.id);
  if (existingError) throw new Error("ai_models read failed");
  const { data: settings, error: settingsError } = await db.from("system_settings")
    .select("key, value").like("key", "default_ai_model%");
  if (settingsError) throw new Error("system_settings read failed");
  const inUse = new Set<string>();
  for (const s of settings ?? []) {
    const v = typeof s.value === "string" ? JSON.parse(s.value) : s.value;
    if (v?.provider_code === providerCode && v?.model_id) inUse.add(v.model_id);
  }

  const plan = planCatalogSync(existing ?? [], mapped, inUse);
  const row = (m: typeof plan.inserts[number]) => ({
    provider_id: provider.id, model_id: m.model_id, name: m.name, description: m.description,
    capabilities: m.capabilities, context_limit: m.context_limit,
    cost_per_1m_input_tokens: m.cost_per_1m_input_tokens, cost_per_1m_output_tokens: m.cost_per_1m_output_tokens,
    metadata: m.metadata,
  });
  if (plan.inserts.length) {
    const { error } = await db.from("ai_models").insert(plan.inserts.map((m) => ({ ...row(m), is_active: true })));
    if (error) throw new Error(`ai_models insert failed: ${error.message}`);
  }
  for (const u of plan.updates) {
    const patch: Record<string, unknown> = { ...row(u), updated_at: new Date().toISOString() };
    if (u.reactivate) {
      patch.is_active = true;
      patch.metadata = { ...u.metadata, sync_deactivated: false };
    }
    const { error } = await db.from("ai_models").update(patch).eq("id", u.id);
    if (error) throw new Error(`ai_models update failed: ${error.message}`);
  }
  for (const id of plan.deactivateIds) {
    const current = (existing ?? []).find((r: any) => r.id === id);
    const { error } = await db.from("ai_models")
      .update({ is_active: false, metadata: { ...(current?.metadata ?? {}), sync_deactivated: true } }).eq("id", id);
    if (error) throw new Error(`ai_models deactivate failed: ${error.message}`);
  }
  const synced_at = new Date().toISOString();
  await db.from("system_settings").upsert(
    { key: `model_catalog_synced_at_${providerCode}`, value: { at: synced_at } }, { onConflict: "key" },
  );
  return {
    added: plan.inserts.length, updated: plan.updates.length, deactivated: plan.deactivateIds.length,
    kept_in_use: plan.keptInUse, skipped_by_type: mapped.skippedByType, synced_at,
  };
}
