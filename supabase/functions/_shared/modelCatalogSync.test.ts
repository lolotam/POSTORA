// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type ExistingModelRow, mapDeepSeekCatalog, mapOpenRouterCatalog, mapVercelCatalog, planCatalogSync,
} from "./modelCatalogSync.ts";

const vercel = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", description: "d", type: "language", context_window: 400000,
    pricing: { input: "0.00000125", output: "0.00001" } },
  { id: "openai/text-embedding-3-small", name: "Emb", type: "embedding", context_window: 0 },
  { id: "bfl/flux-2-pro", name: "FLUX.2 Pro", type: "image" },
  { id: "alibaba/wan-v2.6-i2v", name: "Wan i2v", type: "video", tags: ["i2v"] },
  { id: "openai/tts-1", name: "TTS", type: "speech" },
  { id: "openai/whisper-1", name: "Whisper", type: "transcription" },
  { id: "openai/gpt-realtime-2", name: "RT", type: "realtime" },
  { id: "cohere/rerank-v3.5", name: "Rerank", type: "reranking" },
  { id: "typesafe-ai/jev", name: "JEV", type: "evaluation" },
];

Deno.test("mapVercelCatalog assigns one capability per gateway type and skips unused types", () => {
  const mapped = mapVercelCatalog(vercel);
  const caps = Object.fromEntries(mapped.models.map((m) => [m.model_id, m.capabilities]));
  assertEquals(caps, {
    "openai/gpt-5.5": ["chat"],
    "openai/text-embedding-3-small": ["embedding"],
    "bfl/flux-2-pro": ["image"],
    "alibaba/wan-v2.6-i2v": ["video"],
    "openai/tts-1": ["tts"],
    "openai/whisper-1": ["stt"],
  });
  assertEquals(mapped.skippedByType, { realtime: 1, reranking: 1, evaluation: 1 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "stt", "tts", "video"]);
});

Deno.test("mapVercelCatalog converts per-token pricing and keeps video tags", () => {
  const byId = Object.fromEntries(mapVercelCatalog(vercel).models.map((m) => [m.model_id, m]));
  assertEquals(byId["openai/gpt-5.5"].cost_per_1m_input_tokens, 1.25);
  assertEquals(byId["openai/gpt-5.5"].cost_per_1m_output_tokens, 10);
  assertEquals(byId["openai/gpt-5.5"].context_limit, 400000);
  assertEquals(byId["alibaba/wan-v2.6-i2v"].metadata.tags, ["i2v"]);
});

Deno.test("mapVercelCatalog records known embedding widths and leaves unknown ones unset", () => {
  const mapped = mapVercelCatalog([
    ...vercel,
    { id: "perplexity/pplx-embed-v1-4b", name: "pplx", type: "embedding" },
  ]);
  const byId = Object.fromEntries(mapped.models.map((m) => [m.model_id, m]));
  assertEquals(byId["openai/text-embedding-3-small"].metadata.embedding_dimensions, { native: 1536 });
  assertEquals(byId["perplexity/pplx-embed-v1-4b"].metadata.embedding_dimensions, undefined);
});

Deno.test("mapOpenRouterCatalog maps text and image output modalities to chat and image", () => {
  const mapped = mapOpenRouterCatalog([
    { id: "a/text", name: "T", context_length: 1000, pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { output_modalities: ["text"] } },
    { id: "g/flash-image", name: "I", pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["image", "text"] } },
    { id: "a/voice", name: "V", architecture: { output_modalities: ["text", "audio"] } },
  ]);
  const caps = Object.fromEntries(mapped.models.map((m) => [m.model_id, m.capabilities]));
  assertEquals(caps, { "a/text": ["chat"], "g/flash-image": ["image", "chat"], "a/voice": ["chat"] });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image"]);
});

Deno.test("mapOpenRouterCatalog adds embedding models with their measured width and skips what nothing can call", () => {
  const mapped = mapOpenRouterCatalog([
    { id: "voyageai/voyage-4", name: "V", architecture: { output_modalities: ["embeddings"] } },
    { id: "thenlper/gte-large", name: "G", architecture: { output_modalities: ["embeddings"] } },
    { id: "some/new-embedder", name: "N", architecture: { output_modalities: ["embeddings"] } },
    { id: "openai/text-embedding-3-small:batch", name: "B", architecture: { output_modalities: ["embeddings"] } },
    { id: "openai/gpt-image-2.5", name: "I", architecture: { output_modalities: ["image"] } },
    { id: "typesafe/jev-1.13", name: "J", architecture: { output_modalities: ["decisions"] } },
  ]);
  const byId = Object.fromEntries(mapped.models.map((m) => [m.model_id, m]));
  assertEquals(Object.keys(byId).sort(), ["some/new-embedder", "thenlper/gte-large", "voyageai/voyage-4"]);
  assertEquals(byId["voyageai/voyage-4"].capabilities, ["embedding"]);
  assertEquals(byId["voyageai/voyage-4"].metadata.embedding_dimensions, { native: 1024, requested: 1024 });
  // gte-large rejects any `dimensions`, so no requested width is recorded.
  assertEquals(byId["thenlper/gte-large"].metadata.embedding_dimensions, { native: 1024 });
  // Unmeasured: listed, but left without a width so the Embedding card keeps it unselectable.
  assertEquals(byId["some/new-embedder"].metadata, {});
  assertEquals(mapped.skippedByType, { batch: 1, image: 1, decisions: 1 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image"]);
});

Deno.test("mapOpenRouterCatalog leaves variable (-1) pricing unset instead of overflowing the column", () => {
  const [router] = mapOpenRouterCatalog([
    { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" },
      architecture: { output_modalities: ["text"] } },
  ]).models;
  assertEquals([router.cost_per_1m_input_tokens, router.cost_per_1m_output_tokens], [null, null]);
});

Deno.test("mapDeepSeekCatalog marks every id as chat", () => {
  const mapped = mapDeepSeekCatalog([{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }]);
  assertEquals(mapped.models.map((m) => [m.model_id, m.capabilities]), [
    ["deepseek-flash", ["chat"]], ["deepseek-v4-pro", ["chat"]],
  ]);
});

/** An ai_models row with a stale name, so the planner always sees it as changed. */
const existingRow = (row: Pick<ExistingModelRow, "id" | "model_id" | "is_active" | "capabilities" | "metadata">): ExistingModelRow => ({
  name: "stale", description: null, context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null, ...row,
});

Deno.test("planCatalogSync inserts new, updates existing, and guards in-use and unmanaged rows", () => {
  const mapped = mapVercelCatalog(vercel.slice(0, 2));
  const plan = planCatalogSync([
    existingRow({ id: "1", model_id: "openai/gpt-5.5", is_active: true, capabilities: ["chat"], metadata: null }),
    existingRow({ id: "2", model_id: "openai/gone", is_active: true, capabilities: ["chat"], metadata: null }),
    existingRow({ id: "3", model_id: "openai/gone-but-default", is_active: true, capabilities: ["chat"], metadata: null }),
    existingRow({ id: "4", model_id: "hand/seeded-embed", is_active: true, capabilities: ["search"], metadata: null }),
  ], mapped, new Set(["openai/gone-but-default"]));
  assertEquals(plan.inserts.map((m) => m.model_id), ["openai/text-embedding-3-small"]);
  assertEquals(plan.updates.map((u) => [u.id, u.reactivate]), [["1", false]]);
  assertEquals(plan.deactivateIds, ["2"]);
  assertEquals(plan.keptInUse, ["openai/gone-but-default"]);
});

Deno.test("planCatalogSync reactivates only rows a previous sync switched off", () => {
  const mapped = mapVercelCatalog(vercel.slice(0, 1));
  const bySync = planCatalogSync([existingRow({ id: "1", model_id: "openai/gpt-5.5", is_active: false,
    capabilities: ["chat"], metadata: { sync_deactivated: true } })], mapped, new Set());
  const byAdmin = planCatalogSync([existingRow({ id: "1", model_id: "openai/gpt-5.5", is_active: false,
    capabilities: ["chat"], metadata: {} })], mapped, new Set());
  assertEquals(bySync.updates[0].reactivate, true);
  assertEquals(byAdmin.updates[0].reactivate, false);
});
