// Pure: turns a provider's /models catalogue into ai_models rows and plans the
// DB diff. No I/O here — modelCatalogSyncRun.ts owns fetching and writing.

export type Capability = "chat" | "image" | "video" | "embedding" | "tts" | "stt";

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
export type ModelUpdate = Omit<CatalogModel, "capabilities"> & {
  id: string;
  capabilities: string[];
  is_active: boolean;
  reactivate: boolean;
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

export function mapOpenRouterCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  for (const raw of data) {
    const row = raw as Row;
    if (!str(row.id)) continue;
    const outputs = ((row.architecture as Row | undefined)?.output_modalities ?? []) as string[];
    const capabilities: Capability[] = [];
    if (outputs.includes("image")) capabilities.push("image");
    if (outputs.includes("text")) capabilities.push("chat");
    if (!capabilities.length) continue;
    const model = baseModel(row, capabilities);
    const pricing = (row.pricing ?? {}) as Row;
    model.cost_per_1m_input_tokens = perMillion(pricing.prompt);
    model.cost_per_1m_output_tokens = perMillion(pricing.completion);
    models.push(model);
  }
  // OpenRouter's /models lists no embedding models, so the embedding rows seeded
  // by hand (each verified live) are outside what this sync may deactivate.
  return { models, skippedByType: {}, managedCapabilities: ["chat", "image"] };
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
    const capabilities = [...new Set([...adminCapabilities, ...model.capabilities])].sort();
    const update: ModelUpdate = { ...model, capabilities, metadata, id: row.id, is_active: reactivate || row.is_active, reactivate };
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
