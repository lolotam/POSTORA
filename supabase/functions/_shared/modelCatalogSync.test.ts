// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type ExistingModelRow, mapAnthropicCatalog, mapDeepSeekCatalog, mapGeminiCatalog, mapIdOnlyChatCatalog,
  mapOpenAICatalog, mapOpenRouterCatalog, mapVercelCatalog, mapXaiCatalog, planCatalogSync,
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
    "typesafe-ai/jev": ["triage"],
  });
  assertEquals(mapped.skippedByType, { realtime: 1, reranking: 1 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "stt", "triage", "tts", "video"]);
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
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "triage"]);
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
  assertEquals(Object.keys(byId).sort(), ["some/new-embedder", "thenlper/gte-large", "typesafe/jev-1.13", "voyageai/voyage-4"]);
  assertEquals(byId["voyageai/voyage-4"].capabilities, ["embedding"]);
  assertEquals(byId["voyageai/voyage-4"].metadata.embedding_dimensions, { native: 1024, requested: 1024 });
  // gte-large rejects any `dimensions`, so no requested width is recorded.
  assertEquals(byId["thenlper/gte-large"].metadata.embedding_dimensions, { native: 1024 });
  // Unmeasured: listed, but left without a width so the Embedding card keeps it unselectable.
  assertEquals(byId["some/new-embedder"].metadata, {});
  assertEquals(byId["typesafe/jev-1.13"].capabilities, ["triage"]);
  assertEquals(mapped.skippedByType, { batch: 1, image: 1 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "triage"]);
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

Deno.test("Jev decision models map to the triage capability on both catalogues", () => {
  const vercelJev = mapVercelCatalog([{ id: "typesafe-ai/jev", name: "Jev", type: "evaluation" }]).models[0];
  const routerJev = mapOpenRouterCatalog([
    { id: "typesafe/jev-1.13", name: "Jev", architecture: { output_modalities: ["decisions"] } },
  ]).models[0];
  assertEquals(vercelJev.capabilities, ["triage"]);
  assertEquals(routerJev.capabilities, ["triage"]);
});

Deno.test("an additive catalogue never erases a curated name, price, context or description", () => {
  const mapped = { models: [{ model_id: "gpt-5", name: "gpt-5", description: null, capabilities: ["chat" as const],
    context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null, metadata: {} }],
    skippedByType: {}, managedCapabilities: ["chat" as const], additiveCapabilities: true as const };
  const row = { ...existingRow({ id: "1", model_id: "gpt-5", is_active: true, capabilities: ["chat"], metadata: null }),
    name: "GPT-5", description: "Flagship", context_limit: 400000, cost_per_1m_input_tokens: "5.0000", cost_per_1m_output_tokens: 15 };
  const plan = planCatalogSync([row], mapped, new Set());
  assertEquals(plan.updates, []);
});

Deno.test("a non-additive catalogue overwrites with null cost, replacing stored values", () => {
  const mapped = { models: [{ model_id: "gpt-5", name: "gpt-5", description: null, capabilities: ["chat" as const],
    context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null, metadata: {} }],
    skippedByType: {}, managedCapabilities: ["chat" as const] };
  const row = { ...existingRow({ id: "1", model_id: "gpt-5", is_active: true, capabilities: ["chat"], metadata: null }),
    name: "gpt-5", description: "Old", context_limit: 400000, cost_per_1m_input_tokens: 5, cost_per_1m_output_tokens: null };
  const plan = planCatalogSync([row], mapped, new Set());
  assertEquals(plan.updates.length, 1);
  assertEquals(plan.updates[0].cost_per_1m_input_tokens, null);
});

Deno.test("an additive catalogue keeps capabilities an admin gave a row", () => {
  const mapped = { models: [{ model_id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: null,
    capabilities: ["chat" as const], context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    metadata: {} }], skippedByType: {}, managedCapabilities: ["chat" as const, "image" as const], additiveCapabilities: true as const };
  const row = { ...existingRow({ id: "1", model_id: "gemini-2.5-flash", is_active: true, capabilities: ["stt", "image", "chat"], metadata: null }),
    name: "Gemini 2.5 Flash" };
  const plan = planCatalogSync([row], mapped, new Set());
  assertEquals(plan.updates, []);
  const replacing = planCatalogSync([row], { ...mapped, additiveCapabilities: undefined }, new Set());
  assertEquals(replacing.updates[0].capabilities, ["chat", "stt"]);
});

const byId = (m: { models: Array<{ model_id: string; capabilities: string[] }> }) =>
  Object.fromEntries(m.models.map((x) => [x.model_id, x.capabilities]));

Deno.test("Anthropic models are chat, with their display name and context window", () => {
  const mapped = mapAnthropicCatalog([{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model", max_input_tokens: 1000000 }]);
  assertEquals(mapped.models[0].name, "Claude Opus 5.5");
  assertEquals(mapped.models[0].capabilities, ["chat"]);
  assertEquals(mapped.models[0].context_limit, 1000000);
  assertEquals(mapped.managedCapabilities, ["chat"]);
  assertEquals(mapped.additiveCapabilities, true);
});

Deno.test("Gemini models map by generation method, with the models/ prefix stripped", () => {
  const mapped = mapGeminiCatalog([
    { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/gemini-2.5-flash-preview-tts", displayName: "TTS", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash-image", displayName: "Image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-embedding-001", displayName: "Emb", supportedGenerationMethods: ["embedContent"] },
    { name: "models/imagen-4.0-generate-001", displayName: "Imagen", supportedGenerationMethods: ["predict"] },
    { name: "models/veo-3.0-generate-001", displayName: "Veo", supportedGenerationMethods: ["predictLongRunning"] },
    { name: "models/aqa", displayName: "AQA", supportedGenerationMethods: ["generateAnswer"] },
    { name: "models/gemma-4-31b-it", displayName: "Gemma", supportedGenerationMethods: ["generateContent"] },
    { name: "models/lyria-3-clip-preview", displayName: "Lyria Clip", supportedGenerationMethods: ["generateContent"] },
    { name: "models/lyria-3-pro-preview", displayName: "Lyria Pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/lyria-3.5", displayName: "Lyria 3.5", supportedGenerationMethods: ["generateContent"] },
    { name: "models/deep-research-preview-04-2026", displayName: "Deep Research", supportedGenerationMethods: ["generateContent"] },
    { name: "models/deep-research-max-preview-04-2026", displayName: "Deep Research Max", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-computer-use-preview-10-2025", displayName: "Computer Use", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-robotics-er-2-preview", displayName: "Robotics", supportedGenerationMethods: ["generateContent"] },
    { name: "models/antigravity-preview-latest", displayName: "Antigravity", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-transcribe", displayName: "Transcribe", supportedGenerationMethods: ["generateContent"] },
    { name: "models/nano-banana-pro-preview", displayName: "Nano Banana", supportedGenerationMethods: ["generateContent"] },
  ]);
  assertEquals(byId(mapped), {
    "gemini-2.5-flash": ["chat"], "gemini-2.5-flash-preview-tts": ["tts"], "gemini-2.5-flash-image": ["image"],
    "gemini-embedding-001": ["embedding"], "imagen-4.0-generate-001": ["image"], "veo-3.0-generate-001": ["video"],
    "gemma-4-31b-it": ["chat"], "gemini-3.5-transcribe": ["stt"], "nano-banana-pro-preview": ["image"],
  });
  // Music and agent models list generateContent like any chat model, so id patterns must
  // win before the generateContent → chat fallback runs, not merely skip an unknown method.
  assertEquals(mapped.skippedByType, { generateAnswer: 1, music: 3, agent: 5 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "stt", "tts", "video"]);
});

Deno.test("OpenAI ids are classified by name; dated snapshots and non-reply models are skipped", () => {
  const mapped = mapOpenAICatalog([
    "gpt-5.5", "gpt-5-nano-2025-08-07", "o4-mini", "chatgpt-4o-latest", "gpt-image-2", "dall-e-3", "gpt-4o-mini-tts",
    "tts-1-hd", "whisper-1", "gpt-4o-transcribe", "text-embedding-3-small", "sora-2", "omni-moderation-latest",
    "gpt-4o-realtime-preview", "gpt-4o-audio-preview", "gpt-4o-search-preview", "computer-use-preview", "babbage-002",
    "gpt-audio", "o3-deep-research",
    // Old-style 4-digit snapshots (no full date), matched by /-\d{4}$/ without catching gpt-4o or o4-mini.
    "gpt-4-0613", "tts-1-1106", "tts-1-hd-1106", "gpt-3.5-turbo-0125", "gpt-3.5-turbo-1106", "gpt-3.5-turbo-instruct-0914",
    // Real ids that don't work through /chat/completions: instruct, codex, *-pro, and live (but not live transcribe).
    "gpt-3.5-turbo-instruct", "gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5.2-codex",
    "gpt-5.3-codex", "o1-pro", "o3-pro", "gpt-5-pro", "gpt-5.2-pro", "gpt-live-1",
    // Real chat ids that must not be caught by the new other/snapshot patterns.
    "gpt-5.1", "gpt-6-luna", "gpt-5.3-chat-latest", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "gpt-4",
    // gpt-live-transcribe must stay stt, not fall into the gpt-live-* "other" exclusion.
    "gpt-live-transcribe",
  ].map((id) => ({ id })));
  assertEquals(byId(mapped), {
    "gpt-5.5": ["chat"], "o4-mini": ["chat"], "chatgpt-4o-latest": ["chat"], "gpt-image-2": ["image"], "dall-e-3": ["image"],
    "gpt-4o-mini-tts": ["tts"], "tts-1-hd": ["tts"], "whisper-1": ["stt"], "gpt-4o-transcribe": ["stt"],
    "text-embedding-3-small": ["embedding"], "sora-2": ["video"],
    "gpt-5.1": ["chat"], "gpt-6-luna": ["chat"], "gpt-5.3-chat-latest": ["chat"], "gpt-4-turbo": ["chat"],
    "gpt-3.5-turbo": ["chat"], "o1": ["chat"], "gpt-4": ["chat"], "gpt-live-transcribe": ["stt"],
  });
  assertEquals(mapped.skippedByType, { snapshot: 7, other: 20 });
});

Deno.test("Z.ai and MiniMax list chat ids only, and the catalogue is partial so nothing is managed", () => {
  const mapped = mapIdOnlyChatCatalog([{ id: "glm-5" }, { id: "MiniMax-M3" }]);
  assertEquals(byId(mapped), { "glm-5": ["chat"], "MiniMax-M3": ["chat"] });
  assertEquals(mapped.managedCapabilities, []);
});

Deno.test("mapIdOnlyChatCatalog never deactivates an active chat row merely absent from its partial list", () => {
  const mapped = mapIdOnlyChatCatalog([{ id: "glm-5" }]);
  const plan = planCatalogSync([
    existingRow({ id: "1", model_id: "glm-4.6v", is_active: true, capabilities: ["chat"], metadata: null }),
  ], mapped, new Set());
  assertEquals(plan.deactivateIds, []);
});

Deno.test("xAI ids split into chat, image and video by name", () => {
  const mapped = mapXaiCatalog([{ id: "grok-4.3" }, { id: "grok-imagine-image-pro" }, { id: "grok-imagine-video-1.5" }, { id: "grok-2-image-1212" }]);
  assertEquals(byId(mapped), { "grok-4.3": ["chat"], "grok-imagine-image-pro": ["image"], "grok-imagine-video-1.5": ["video"], "grok-2-image-1212": ["image"] });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "image", "video"]);
});
