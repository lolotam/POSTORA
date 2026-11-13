import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidAccessToken, HIGGSFIELD_PROVIDER_CODE } from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient } from "../_shared/higgsfield-mcp.ts";
import { type CatalogModel, type MappedCatalog } from "../_shared/modelCatalogSync.ts";
import { runCatalogSync, CatalogSyncError, CatalogStorageError, type CatalogDb } from "../_shared/modelCatalogSyncRun.ts";
import { withSignal } from "../_shared/aiProviderHealth.ts";

const METADATA_KEYS = ["parameters", "aspect_ratios", "durations", "duration_range", "medias", "tags", "supports_unlim", "output_type", "provider_name"];

function catalog(payload: unknown) {
  const items = Array.isArray(payload) ? payload
    : payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items) ? payload.items : [];
  return items.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") return [];
    const row = item as Record<string, unknown>;
    return [{ id: item.id, name: typeof row.name === "string" ? row.name : item.id,
      description: typeof row.description === "string" ? row.description : null,
      metadata: Object.fromEntries(METADATA_KEYS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])) }];
  });
}

type Explore = (capability: "video" | "image") => Promise<unknown>;

/** Discovery and cleanup affect only the api_key partition that media generation reads. */
export async function syncHiggsfieldCatalog(db: SupabaseClient, explore?: Explore, options: { leaseHolder?: string; signal?: AbortSignal } = {}) {
  // The same lease excludes health and legacy admin syncs before any catalogue
  // read. One fenced transaction writes the complete diff and timestamp together.
  const holder = options.leaseHolder ?? crypto.randomUUID();
  const job = "ai-provider-health";
  if (!options.leaseHolder) {
    const { data: acquired, error } = await db.rpc("acquire_cron_run_lease", {
      p_job: job, p_holder: holder, p_ttl: "120 seconds",
    }).abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new CatalogStorageError("Higgsfield catalogue lease could not be acquired");
    if (acquired !== true) throw new CatalogSyncError("A provider check or model sync is already running. Try again later.");
  }
  try {
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    if (!explore) {
      await withSignal(getValidAccessToken(db), signal);
      const mcp = await withSignal(HiggsfieldMcpClient.create(db), signal);
      mcp.withDeadline(Date.now() + 15_000);
      explore = (capability) => mcp.callTool("models_explore", { action: "list", type: capability, limit: 100 });
    }
    const found = new Map<string, CatalogModel>();
    for (const capability of ["video", "image"] as const) {
      for (const model of catalog(await withSignal(explore(capability), signal))) {
        const existing = found.get(model.id);
        found.set(model.id, { model_id: model.id, name: model.name, description: model.description,
          capabilities: [...new Set([...(existing?.capabilities ?? []), capability])],
          metadata: { ...existing?.metadata, ...model.metadata }, context_limit: null,
          cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null });
      }
    }
    if (!found.size) throw new CatalogSyncError("Higgsfield returned an empty model catalog");
    const catalogue: MappedCatalog = { models: [...found.values()], managedCapabilities: ["video", "image"],
      additiveCapabilities: true, skippedByType: {} };
    // Higgsfield media models stay in the api_key partition: generate-video and
    // generate-image read only that partition. The oauth partition belongs to the
    // AI-provider login adapters (ai_provider_oauth), which this sync must not touch.
    // CatalogDb is the structural SDK seam; avoid instantiating Supabase's recursive query types.
    const report = await runCatalogSync(db as unknown as CatalogDb, HIGGSFIELD_PROVIDER_CODE, fetch, {
      authMethod: "api_key", catalogue, leaseHolder: holder, signal,
    });
    return { discovered: found.size, activated: report.activated, added: report.added, updated: report.updated, deactivated: report.deactivated };
  } finally {
    if (!options.leaseHolder) {
      try {
        const { error: releaseError } = await db.rpc("release_cron_run_lease", { p_job: job, p_holder: holder })
          .abortSignal(AbortSignal.timeout(3_000));
        if (releaseError) console.error("event: 'higgsfield_catalogue_lease_release_failed'");
      } catch {
        console.error("event: 'higgsfield_catalogue_lease_release_failed'");
      }
    }
  }
}
