import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidAccessToken, HIGGSFIELD_PROVIDER_CODE } from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient } from "../_shared/higgsfield-mcp.ts";

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
export async function syncHiggsfieldCatalog(db: SupabaseClient, explore?: Explore) {
  const { data: provider, error: providerError } = await db.from("ai_providers").select("id")
    .eq("provider_code", HIGGSFIELD_PROVIDER_CODE).maybeSingle();
  if (providerError) throw new Error("Higgsfield provider could not be read");
  if (!provider) throw new Error("Higgsfield provider row is missing");
  if (!explore) {
    await getValidAccessToken(db);
    const mcp = await HiggsfieldMcpClient.create(db);
    explore = (capability) => mcp.callTool("models_explore", { action: "list", type: capability, limit: 100 });
  }
  const found = new Map<string, { model: ReturnType<typeof catalog>[number]; capability: string }>();
  for (const capability of ["video", "image"] as const) {
    for (const model of catalog(await explore(capability))) found.set(model.id, { model, capability });
  }
  if (!found.size) throw new Error("Higgsfield returned an empty model catalog");
  for (const [model_id, { model, capability }] of found) {
    // Higgsfield media models stay in the api_key partition: generate-video and
    // generate-image read only that partition. The oauth partition belongs to the
    // AI-provider login adapters (ai_provider_oauth), which this sync must not touch.
    const { error } = await db.from("ai_models").upsert({
      provider_id: provider.id, model_id, name: model.name, description: model.description,
      capabilities: [capability], metadata: model.metadata, is_active: true, auth_method: "api_key",
    }, { onConflict: "provider_id,model_id,auth_method" });
    if (error) throw new Error("Higgsfield catalogue write failed");
  }
  const { data: stale, error: staleError } = await db.from("ai_models").select("id, model_id")
    .eq("provider_id", provider.id).eq("auth_method", "api_key").eq("is_active", true);
  if (staleError) throw new Error("Higgsfield catalogue cleanup read failed");
  const ids = (stale ?? []).filter((row) => !found.has(row.model_id)).map((row) => row.id);
  if (ids.length) {
    const { error } = await db.from("ai_models").update({ is_active: false }).in("id", ids).eq("auth_method", "api_key");
    if (error) throw new Error("Higgsfield catalogue cleanup write failed");
  }
  return { discovered: found.size, activated: found.size, deactivated: ids.length };
}
