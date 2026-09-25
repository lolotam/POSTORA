// Pure: turns a provider's /models catalogue into ai_models rows and plans the
// DB diff. No I/O here — modelCatalogSyncRun.ts owns fetching and writing.

export type Capability = "chat" | "image" | "video" | "embedding" | "tts" | "stt" | "triage";

export interface CatalogModel {
  model_id: string;
  name: string;
  description: string | null;
  capabilities: Capability[];
  context_limit: number | null;
  cost_per_1m_input_tokens: number | null;
  cost_per_1m_output_tokens: number | null;
  metadata: Record<string, unknown>;
}

export interface MappedCatalog {
  models: CatalogModel[];
  skippedByType: Record<string, number>;
  /** Capabilities this catalogue is authoritative for; rows outside them are never touched. */
  managedCapabilities: Capability[];
  /** Direct providers: never remove a capability an admin gave a row. */
  additiveCapabilities?: true;
}

export interface ExistingModelRow {
  id: string;
  model_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  capabilities: string[];
  context_limit: number | null;
  /** NUMERIC(10,4); PostgREST may hand it back as a string. */
  cost_per_1m_input_tokens: number | string | null;
  cost_per_1m_output_tokens: number | string | null;
  metadata: Record<string, unknown> | null;
}

/** A catalogue model merged onto its row. Capabilities widen to string: admin-added ones are kept. */
export type ModelUpdate = Omit<CatalogModel, "capabilities" | "cost_per_1m_input_tokens" | "cost_per_1m_output_tokens"> & {
  id: string;
  capabilities: string[];
  is_active: boolean;
  reactivate: boolean;
  cost_per_1m_input_tokens: number | string | null;
  cost_per_1m_output_tokens: number | string | null;
};

export interface SyncPlan {
  inserts: CatalogModel[];
  /** Existing rows whose stored values differ from the merged catalogue values; unchanged rows are absent. */
  updates: ModelUpdate[];
  deactivateIds: string[];
  keptInUse: string[];
}

const VERCEL_TYPE_CAPABILITY: Record<string, Capability> = {
  language: "chat",
  image: "image",
  video: "video",
  embedding: "embedding",
  speech: "tts",
  transcription: "stt",
  evaluation: "triage",
};

// The gateway catalogue carries no vector width. Widths below are the vendors'
// published defaults; `requested` is set only where the model accepts a
// `dimensions` parameter that lands it in a storable column. Anything not listed
// stays unselectable in the Embedding card ("unknown vector width") until a live
// call proves its width.
export const EMBEDDING_WIDTHS: Record<string, { native: number; requested?: number }> = {
  "openai/text-embedding-3-small": { native: 1536 },
  "openai/text-embedding-3-large": { native: 3072, requested: 1536 },
  "openai/text-embedding-ada-002": { native: 1536 },
  "google/gemini-embedding-001": { native: 3072, requested: 1536 },
  "cohere/embed-v4.0": { native: 1536 },
  "mistral/mistral-embed": { native: 1024 },
  "amazon/titan-embed-text-v2": { native: 1024 },
  "alibaba/qwen3-embedding-0.6b": { native: 1024 },
  "voyage/voyage-3-large": { native: 1024 },
  "voyage/voyage-3.5": { native: 1024 },
  "voyage/voyage-3.5-lite": { native: 1024 },
  "voyage/voyage-4": { native: 1024 },
  "voyage/voyage-4-large": { native: 1024 },
  "voyage/voyage-4-lite": { native: 1024 },
  "voyage/voyage-code-3": { native: 1024 },
};

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const positiveInt = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);
// OpenRouter prices its router models (openrouter/auto, …) as "-1", meaning variable.
// A negative price has no per-million value, and ×1e6 would overflow numeric(10,4).
const perMillion = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};

function baseModel(row: Row, capabilities: Capability[]): CatalogModel {
  const id = String(row.id);
  return {
    model_id: id,
    name: str(row.name) ?? id,
    description: str(row.description),
    capabilities,
    context_limit: positiveInt(row.context_window ?? row.context_length),
    cost_per_1m_input_tokens: null,
    cost_per_1m_output_tokens: null,
    metadata: {},
  };
}

export function mapVercelCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  for (const raw of data) {
    const row = raw as Row;
    if (!str(row.id)) continue;
    const type = String(row.type ?? "");
    const capability = VERCEL_TYPE_CAPABILITY[type];
    if (!capability) {
      skippedByType[type] = (skippedByType[type] ?? 0) + 1;
      continue;
    }
    const model = baseModel(row, [capability]);
    const pricing = (row.pricing ?? {}) as Row;
    model.cost_per_1m_input_tokens = perMillion(pricing.input);
    model.cost_per_1m_output_tokens = perMillion(pricing.output);
    if (Array.isArray(row.tags) && row.tags.length) model.metadata.tags = row.tags;
    const width = EMBEDDING_WIDTHS[model.model_id];
    if (capability === "embedding" && width) model.metadata.embedding_dimensions = width;
    models.push(model);
  }
  return { models, skippedByType, managedCapabilities: Object.values(VERCEL_TYPE_CAPABILITY) };
}

// Widths the live OpenRouter /embeddings endpoint returned (probed 2026-09-25).
// `requested` only where the model accepts `dimensions`; gte-large, e5-large-v2 and
// bge-large reject it even at their native 1024. Rows seeded before this table keep
// the widths already recorded on them.
export const OPENROUTER_EMBEDDING_WIDTHS: Record<string, { native: number; requested?: number }> = {
  "voyageai/voyage-4": { native: 1024, requested: 1024 },
  "voyageai/voyage-4-large": { native: 1024, requested: 1024 },
  "voyageai/voyage-4-lite": { native: 1024, requested: 1024 },
  "voyageai/voyage-code-4": { native: 1024, requested: 1024 },
  "voyageai/voyage-multimodal-3.5": { native: 1024, requested: 1024 },
  "intfloat/multilingual-e5-large": { native: 1024, requested: 1024 },
  "baai/bge-m3": { native: 1024, requested: 1024 },
  "thenlper/gte-large": { native: 1024 },
  "intfloat/e5-large-v2": { native: 1024 },
  "baai/bge-large-en-v1.5": { native: 1024 },
  "nvidia/nemotron-3-embed-1b:free": { native: 2048 },
  "thenlper/gte-base": { native: 768 },
  "intfloat/e5-base-v2": { native: 768 },
  "sentence-transformers/all-mpnet-base-v2": { native: 768 },
};

// Fetched with ?output_modalities=all. Image-only, video, speech, transcription,
// and rerank models have no OpenRouter runtime in Postora yet; the `:batch`
// embedding ids are asynchronous duplicates. Decision models map to `triage`,
// used by the AI agent's triage step.
export function mapOpenRouterCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  const skip = (type: string) => { skippedByType[type] = (skippedByType[type] ?? 0) + 1; };
  for (const raw of data) {
    const row = raw as Row;
    if (!str(row.id)) continue;
    const outputs = ((row.architecture as Row | undefined)?.output_modalities ?? []) as string[];
    const capabilities: Capability[] = [];
    if (outputs.includes("text")) {
      if (outputs.includes("image")) capabilities.push("image");
      capabilities.push("chat");
    } else if (outputs.includes("embeddings")) {
      if (String(row.id).endsWith(":batch")) {
        skip("batch");
        continue;
      }
      capabilities.push("embedding");
    } else if (outputs.includes("decisions")) {
      capabilities.push("triage");
    }
    if (!capabilities.length) {
      skip(outputs.join("+") || "unknown");
      continue;
    }
    const model = baseModel(row, capabilities);
    const pricing = (row.pricing ?? {}) as Row;
    model.cost_per_1m_input_tokens = perMillion(pricing.prompt);
    model.cost_per_1m_output_tokens = perMillion(pricing.completion);
    const width = OPENROUTER_EMBEDDING_WIDTHS[model.model_id];
    if (capabilities.includes("embedding") && width) model.metadata.embedding_dimensions = width;
    models.push(model);
  }
  return { models, skippedByType, managedCapabilities: ["chat", "image", "embedding", "triage"] };
}

export function mapDeepSeekCatalog(data: unknown[]): MappedCatalog {
  const models = data
    .map((raw) => raw as Row)
    .filter((row) => str(row.id))
    .map((row) => baseModel(row, ["chat"]));
  return { models, skippedByType: {}, managedCapabilities: ["chat"] };
}

// Stable across key order: jsonb hands keys back in its own order.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// The cost columns are NUMERIC(10,4); compare at the precision they store.
const fourDp = (v: number | string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : null;
};

function isUnchanged(row: ExistingModelRow, next: ModelUpdate): boolean {
  return row.name === next.name &&
    (row.description ?? null) === next.description &&
    (row.context_limit ?? null) === next.context_limit &&
    fourDp(row.cost_per_1m_input_tokens) === fourDp(next.cost_per_1m_input_tokens) &&
    fourDp(row.cost_per_1m_output_tokens) === fourDp(next.cost_per_1m_output_tokens) &&
    row.is_active === next.is_active &&
    stableJson([...row.capabilities].sort()) === stableJson(next.capabilities) &&
    stableJson(row.metadata ?? {}) === stableJson(next.metadata);
}

export function planCatalogSync(
  existing: ExistingModelRow[],
  mapped: MappedCatalog,
  inUseModelIds: Set<string>,
): SyncPlan {
  const found = new Map(mapped.models.map((m) => [m.model_id, m]));
  const known = new Map(existing.map((row) => [row.model_id, row]));
  const managed = new Set<string>(mapped.managedCapabilities);
  const plan: SyncPlan = { inserts: [], updates: [], deactivateIds: [], keptInUse: [] };

  for (const model of mapped.models) {
    const row = known.get(model.model_id);
    if (!row) {
      plan.inserts.push(model);
      continue;
    }
    const reactivate = !row.is_active && row.metadata?.sync_deactivated === true;
    const metadata = { ...(row.metadata ?? {}), ...model.metadata };
    if (reactivate) metadata.sync_deactivated = false;
    // Capabilities outside what this catalogue manages (search, agent, ...) were set by an admin.
    const adminCapabilities = row.capabilities.filter((c) => !managed.has(c));
    const capabilities = mapped.additiveCapabilities
      ? [...new Set([...row.capabilities, ...model.capabilities])].sort()
      : [...new Set([...adminCapabilities, ...model.capabilities])].sort();
    // Direct (additive) providers preserve curated names, prices and context when the catalogue lacks them.
    // Indirect (aggregate) providers overwrite with catalogue values, including nulls.
    const update: ModelUpdate = mapped.additiveCapabilities
      ? {
        ...model,
        name: model.name === model.model_id && row.name ? row.name : model.name,
        description: model.description ?? row.description ?? null,
        context_limit: model.context_limit ?? row.context_limit ?? null,
        cost_per_1m_input_tokens: model.cost_per_1m_input_tokens ?? row.cost_per_1m_input_tokens,
        cost_per_1m_output_tokens: model.cost_per_1m_output_tokens ?? row.cost_per_1m_output_tokens,
        capabilities, metadata, id: row.id, is_active: reactivate || row.is_active, reactivate,
      }
      : {
        ...model,
        capabilities, metadata, id: row.id, is_active: reactivate || row.is_active, reactivate,
      };
    if (!isUnchanged(row, update)) plan.updates.push(update);
  }
  for (const row of existing) {
    if (!row.is_active || found.has(row.model_id)) continue;
    if (!row.capabilities.some((c) => managed.has(c))) continue;
    if (inUseModelIds.has(row.model_id)) plan.keptInUse.push(row.model_id);
    else plan.deactivateIds.push(row.id);
  }
  return plan;
}

// Direct providers (below) list only what they serve today, often as bare ids. Their rows were
// curated by hand first, so these catalogues add, refresh and retire models but never strip a
// capability an admin gave a row (see planCatalogSync).

const CAPABILITY_SET = new Set<string>(["chat", "image", "video", "embedding", "tts", "stt"]);

function idOnly(data: unknown[], classify: (id: string) => Capability | string): MappedCatalog & { models: CatalogModel[] } {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  for (const raw of data) {
    const id = str((raw as Row).id);
    if (!id) continue;
    const kind = classify(id);
    if (!CAPABILITY_SET.has(kind)) {
      skippedByType[kind] = (skippedByType[kind] ?? 0) + 1;
      continue;
    }
    models.push(baseModel(raw as Row, [kind as Capability]));
  }
  return { models, skippedByType, managedCapabilities: [], additiveCapabilities: true };
}

export function mapAnthropicCatalog(data: unknown[]): MappedCatalog {
  const models = data.map((raw) => raw as Row).filter((row) => str(row.id)).map((row) => {
    const model = baseModel(row, ["chat"]);
    model.name = str(row.display_name) ?? model.name;
    model.context_limit = positiveInt(row.max_input_tokens);
    return model;
  });
  return { models, skippedByType: {}, managedCapabilities: ["chat"], additiveCapabilities: true };
}

function geminiCapability(id: string, methods: string[]): Capability | string {
  // Music and agent/tool models (Lyria, Deep Research, computer-use, robotics, Antigravity) list
  // generateContent like any chat model, so id patterns must be checked before the
  // generateContent → chat fallback below, not left to fall through to "chat".
  if (/^lyria/i.test(id)) return "music";
  if (/deep-research|computer-use|robotics|antigravity/i.test(id)) return "agent";
  if (/transcribe/i.test(id)) return "stt";
  if (methods.includes("predictLongRunning")) return "video";
  if (methods.includes("predict")) return "image";
  if (methods.includes("embedContent")) return "embedding";
  if (methods.includes("generateContent")) {
    if (/tts/i.test(id)) return "tts";
    if (/image/i.test(id) || /nano-banana/i.test(id)) return "image";
    return "chat";
  }
  return methods[0] ?? "unknown";
}

export function mapGeminiCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  for (const raw of data) {
    const row = raw as Row;
    const id = str(row.name)?.replace(/^models\//, "");
    if (!id) continue;
    const kind = geminiCapability(id, (row.supportedGenerationMethods ?? []) as string[]);
    if (!CAPABILITY_SET.has(kind)) {
      skippedByType[kind] = (skippedByType[kind] ?? 0) + 1;
      continue;
    }
    const model = baseModel({ ...row, id }, [kind as Capability]);
    model.name = str(row.displayName) ?? id;
    model.context_limit = positiveInt(row.inputTokenLimit);
    models.push(model);
  }
  return { models, skippedByType, managedCapabilities: ["chat", "image", "video", "embedding", "tts", "stt"], additiveCapabilities: true };
}

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
// Old-style snapshots that predate the full-date convention, e.g. gpt-4-0613, tts-1-1106.
// Four digits after a trailing dash; doesn't catch gpt-4o or o4-mini (no trailing dash+digits).
const OLD_SNAPSHOT = /-\d{4}$/;
function openAICapability(id: string): Capability | string {
  if (DATED_SNAPSHOT.test(id) || OLD_SNAPSHOT.test(id)) return "snapshot";
  // instruct/codex/*-pro ids and gpt-live-<n> don't work through /chat/completions.
  // gpt-live-\d (not \w) so gpt-live-transcribe falls through to the stt check below.
  if (/moderation|realtime|audio|search|computer-use|deep-research|instruct|codex|-pro$|^gpt-live-\d|^babbage|^davinci|^ft:/.test(id)) return "other";
  if (/^(gpt-image|dall-e|chatgpt-image)/.test(id)) return "image";
  if (/tts/.test(id)) return "tts";
  if (/whisper|transcribe/.test(id)) return "stt";
  if (/embedding/.test(id)) return "embedding";
  if (/^sora/.test(id)) return "video";
  if (/^(gpt-|o\d|chatgpt-)/.test(id)) return "chat";
  return "other";
}

export function mapOpenAICatalog(data: unknown[]): MappedCatalog {
  const mapped = idOnly(data, openAICapability);
  return { ...mapped, managedCapabilities: ["chat", "image", "tts", "stt", "embedding", "video"] };
}

// Z.ai and MiniMax: /models lists their chat models only, and that list is itself PARTIAL —
// it omits live chat models (e.g. glm-4.6v, glm-4.5-flash, MiniMax-M1). managedCapabilities
// stays empty so a sync can add new ids and refresh known ones but can never deactivate a
// chat row for being merely absent from this incomplete catalogue.
export function mapIdOnlyChatCatalog(data: unknown[]): MappedCatalog {
  return { ...idOnly(data, () => "chat"), managedCapabilities: [] };
}

function xaiCapability(id: string): Capability {
  if (/video/.test(id)) return "video";
  if (/image/.test(id)) return "image";
  return "chat";
}

export function mapXaiCatalog(data: unknown[]): MappedCatalog {
  return { ...idOnly(data, xaiCapability), managedCapabilities: ["chat", "image", "video"] };
}
