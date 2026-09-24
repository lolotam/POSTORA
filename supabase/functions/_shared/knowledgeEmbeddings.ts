import {
  EMBEDDING_DIMENSIONS as OLLAMA_DIMENSIONS,
  EMBEDDING_MODEL as DEFAULT_OLLAMA_MODEL,
  embedWithOllama,
} from "./ollamaEmbeddings.ts";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";
const GEMINI_MODEL = "gemini-embedding-001";
const GEMINI_DIMENSIONS = 1536;
const OPENAI_ENDPOINT = "https://api.openai.com/v1/embeddings";
// OpenRouter does serve embeddings, even though /api/v1/models lists only chat
// models — that catalog is not evidence of what /embeddings accepts. Each
// seeded OpenRouter model was verified by a live call before being offered.
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
// Jina speaks the OpenAI dialect plus a `task` field: passages and queries are
// embedded asymmetrically, which is what makes its retrieval scores good.
// jina-embeddings-v5-omni-small is 1024 wide and refuses a larger `dimensions`
// (measured 2026-09-05), so it lives in the 1024 column.
const JINA_ENDPOINT = "https://api.jina.ai/v1/embeddings";
// Vercel AI Gateway speaks the OpenAI embeddings dialect; model ids carry the
// vendor ("openai/text-embedding-3-small"). Its key is read from the env like
// every other embedding provider: set AI_GATEWAY_API_KEY in the stack .env.
const VERCEL_ENDPOINT = "https://ai-gateway.vercel.sh/v1/embeddings";

// ai_knowledge_chunks has exactly two vector columns; a width outside this set
// has no column to live in and must never be written.
export const STORABLE_EMBEDDING_DIMENSIONS = [1024, 1536] as const;

// system_settings keys for the admin embedding ladder and for the corpus-owner
// registry. The owner rows record which model produced the vectors in a column
// so a later selection cannot silently mix vector spaces.
const EMBEDDING_SETTING_KEYS = [
  "default_ai_model_embedding",
  "default_ai_model_embedding_fallback",
  "default_ai_model_embedding_fallback_2",
] as const;
const columnOwnerKey = (column: EmbeddingConfig["column"]) =>
  `embedding_column_owner_${column}`;

export type EmbeddingProvider = "gemini" | "ollama" | "openai" | "openrouter" | "jina" | "vercel";
/**
 * What the text is for. Providers with asymmetric retrieval models (Jina)
 * embed a stored passage and a search query differently; the others ignore it.
 */
export type EmbeddingPurpose = "passage" | "query";
export type EnvironmentReader = (name: string) => string | undefined;

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  column: "embedding" | "embedding_bge_m3";
  dimensions: number;
  model: string;
  ollamaBaseUrl?: string;
};

export type EmbeddingSelection = {
  provider_code: string;
  model_id: string;
};

// Selection of a model whose recorded width fits no vector column. Thrown
// rather than skipped: the admin explicitly picked the model, so a silent
// substitution would be the incident class this ladder exists to prevent.
export class UnstorableEmbeddingWidthError extends Error {
  constructor(selection: EmbeddingSelection, width: number) {
    super(
      `Embedding model ${selection.provider_code}/${selection.model_id} produces ${width}-dimensional vectors; ` +
        `only ${STORABLE_EMBEDDING_DIMENSIONS.join(" and ")} can be stored in ai_knowledge_chunks`,
    );
    this.name = "UnstorableEmbeddingWidthError";
  }
}

// Selection that would change which model owns a populated vector column.
// Existing vectors are only comparable within one model, so switching owners
// degrades retrieval to noise until the corpus is re-embedded (out of scope).
export class EmbeddingColumnOwnershipError extends Error {
  constructor(
    column: EmbeddingConfig["column"],
    owner: string,
    selection: EmbeddingSelection,
  ) {
    super(
      `Embedding column "${column}" already holds vectors from ${owner}; ` +
        `switching to ${selection.provider_code}/${selection.model_id} requires re-embedding the existing corpus ` +
        `(not implemented). Re-select the owning model, or clear the corpus first.`,
    );
    this.name = "EmbeddingColumnOwnershipError";
  }
}

function configuredValue(
  readEnvironment: EnvironmentReader,
  name: string,
  fallback: string,
): string {
  return readEnvironment(name)?.trim() || fallback;
}

export function embeddingColumnFor(dimensions: number): EmbeddingConfig["column"] {
  if (dimensions === GEMINI_DIMENSIONS) return "embedding";
  if (dimensions === OLLAMA_DIMENSIONS) return "embedding_bge_m3";
  throw new Error(`No vector column stores ${dimensions}-dimensional embeddings`);
}

export function resolveEmbeddingConfig(
  readEnvironment: EnvironmentReader = Deno.env.get,
): EmbeddingConfig {
  // Default to "ollama" (self-hosted bge-m3) — this server has no Gemini key
  // configured for embeddings. Set EMBEDDING_PROVIDER=gemini explicitly to opt in.
  const provider = configuredValue(readEnvironment, "EMBEDDING_PROVIDER", "ollama");

  if (provider === "gemini") {
    const column = configuredValue(readEnvironment, "EMBEDDING_COLUMN", "embedding");
    const dimensions = Number(configuredValue(readEnvironment, "EMBEDDING_DIMENSIONS", "1536"));
    if (column !== "embedding") {
      throw new Error("Gemini requires EMBEDDING_COLUMN=embedding");
    }
    if (dimensions !== GEMINI_DIMENSIONS) {
      throw new Error("Gemini requires EMBEDDING_DIMENSIONS=1536");
    }
    return { provider, column, dimensions, model: GEMINI_MODEL };
  }

  if (provider === "ollama") {
    const column = configuredValue(
      readEnvironment,
      "EMBEDDING_COLUMN",
      "embedding_bge_m3",
    );
    const dimensions = Number(configuredValue(readEnvironment, "EMBEDDING_DIMENSIONS", "1024"));
    if (column !== "embedding_bge_m3") {
      throw new Error("Ollama requires EMBEDDING_COLUMN=embedding_bge_m3");
    }
    if (dimensions !== OLLAMA_DIMENSIONS) {
      throw new Error("Ollama requires EMBEDDING_DIMENSIONS=1024");
    }
    return {
      provider,
      column,
      dimensions,
      model: configuredValue(readEnvironment, "OLLAMA_EMBEDDING_MODEL", DEFAULT_OLLAMA_MODEL),
      ollamaBaseUrl: configuredValue(readEnvironment, "OLLAMA_BASE_URL", "http://ollama:11434"),
    };
  }

  throw new Error("EMBEDDING_PROVIDER must be gemini or ollama");
}

function assertEmbeddingDimensions(config: EmbeddingConfig, embedding: number[]): void {
  if (embedding.length !== config.dimensions) {
    throw new Error(`Embedding expected ${config.dimensions} dimensions`);
  }
}

export function embeddingRecord(
  config: EmbeddingConfig,
  embedding: number[],
): Record<EmbeddingConfig["column"], number[]> {
  assertEmbeddingDimensions(config, embedding);
  return { [config.column]: embedding } as Record<EmbeddingConfig["column"], number[]>;
}

// The RPC is bound to the vector column, not the provider: any 1536-d model
// (gemini or openai) matches through match_ai_knowledge_chunks, any 1024-d
// model through the bge-m3 matcher.
export function retrievalRpcName(config: EmbeddingConfig): string {
  return config.column === "embedding"
    ? "match_ai_knowledge_chunks"
    : "match_ai_knowledge_chunks_bge_m3";
}

// The account-scoped twin of each matcher. Separate functions rather than an
// overload with a defaulted parameter: a PostgREST call carrying the original
// three arguments would match both candidates and fail to resolve, which would
// break live callers during the expand-deploy-contract window.
export function accountRetrievalRpcName(config: EmbeddingConfig): string {
  return `${retrievalRpcName(config)}_for_account`;
}

// Canonical config for a provider, ignoring the primary EMBEDDING_COLUMN /
// EMBEDDING_DIMENSIONS overrides (those describe the primary only). Used to
// build the fallback leg of a dual configuration.
function providerConfig(
  readEnvironment: EnvironmentReader,
  provider: string,
): EmbeddingConfig {
  if (provider === "gemini") {
    return { provider, column: "embedding", dimensions: GEMINI_DIMENSIONS, model: GEMINI_MODEL };
  }
  if (provider === "ollama") {
    return {
      provider,
      column: "embedding_bge_m3",
      dimensions: OLLAMA_DIMENSIONS,
      model: configuredValue(readEnvironment, "OLLAMA_EMBEDDING_MODEL", DEFAULT_OLLAMA_MODEL),
      ollamaBaseUrl: configuredValue(readEnvironment, "OLLAMA_BASE_URL", "http://ollama:11434"),
    };
  }
  throw new Error("EMBEDDING_FALLBACK_PROVIDER must be gemini or ollama");
}

export type DualEmbeddingConfig = {
  primary: EmbeddingConfig;
  fallback: EmbeddingConfig | null;
};

// Primary provider comes from EMBEDDING_PROVIDER (validated by
// resolveEmbeddingConfig). An optional EMBEDDING_FALLBACK_PROVIDER names a
// second provider whose vectors are written alongside the primary at ingest so
// retrieval can fail over to it when the primary is unavailable. No fallback
// env => single-provider behaviour, unchanged.
export function resolveDualEmbeddingConfig(
  readEnvironment: EnvironmentReader = Deno.env.get,
): DualEmbeddingConfig {
  const primary = resolveEmbeddingConfig(readEnvironment);
  const fallbackProvider = readEnvironment("EMBEDDING_FALLBACK_PROVIDER")?.trim();
  if (!fallbackProvider) return { primary, fallback: null };
  if (fallbackProvider === primary.provider) {
    throw new Error("EMBEDDING_FALLBACK_PROVIDER must differ from EMBEDDING_PROVIDER");
  }
  return { primary, fallback: providerConfig(readEnvironment, fallbackProvider) };
}

// ---------------------------------------------------------------------------
// Admin-selected embedding ladder (system_settings) with env fallback.
// ---------------------------------------------------------------------------

export type EmbeddingModelCatalogRow = {
  provider_code: string;
  model_id: string;
  is_active: boolean;
  capabilities: string[];
  metadata?: Record<string, unknown> | null;
};

export type ColumnOwners = Partial<Record<EmbeddingConfig["column"], string>>;

// Width Postora would actually request from the model: the requested dimension
// when the model supports one, else the native width. Null when the catalog row
// carries no dimensionality record at all.
export function recordedEmbeddingWidth(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  const dims = metadata?.embedding_dimensions;
  if (!dims || typeof dims !== "object") return null;
  const record = dims as { native?: unknown; requested?: unknown };
  const width = typeof record.requested === "number"
    ? record.requested
    : record.native;
  return typeof width === "number" ? width : null;
}

function isStorableWidth(width: number): boolean {
  return (STORABLE_EMBEDDING_DIMENSIONS as readonly number[]).includes(width);
}

function selectionConfig(
  selection: EmbeddingSelection,
  width: number,
  readEnvironment: EnvironmentReader,
): EmbeddingConfig {
  const column = embeddingColumnFor(width);
  if (selection.provider_code === "gemini" || selection.provider_code === "openai") {
    return {
      provider: selection.provider_code,
      column,
      dimensions: width,
      model: selection.model_id,
    };
  }
  if (selection.provider_code === "ollama") {
    return {
      provider: "ollama",
      column,
      dimensions: width,
      model: selection.model_id,
      ollamaBaseUrl: configuredValue(readEnvironment, "OLLAMA_BASE_URL", "http://ollama:11434"),
    };
  }
  if (selection.provider_code === "openrouter" || selection.provider_code === "jina" || selection.provider_code === "vercel") {
    return {
      provider: selection.provider_code,
      column,
      dimensions: width,
      model: selection.model_id,
    };
  }
  // Any other provider code has no caller. The tier is skipped by the resolver
  // before reaching this throw.
  throw new Error(`No embedding caller for provider ${selection.provider_code}`);
}

function ownerKeyOf(config: EmbeddingConfig): string {
  return `${config.provider}/${config.model}`;
}

function assertSelectionOwnsColumns(
  configs: EmbeddingConfig[],
  columnOwners: ColumnOwners,
): void {
  for (const config of configs) {
    const owner = columnOwners[config.column];
    if (owner && owner !== ownerKeyOf(config)) {
      throw new EmbeddingColumnOwnershipError(
        config.column,
        owner,
        { provider_code: config.provider, model_id: config.model },
      );
    }
  }
}

// Pure ladder resolution so the policy is testable without a database.
//
// Tier semantics:
//   * No usable primary selection (rows absent, malformed, model missing from
//     the catalog, inactive, or without the embedding capability) falls back to
//     today's env-based behaviour — the incident-prevention guarantee.
//   * A selected model whose recorded width fits no vector column throws
//     UnstorableEmbeddingWidthError (never silently stored in the wrong column).
//   * A selection that would change the owning model of a populated column
//     throws EmbeddingColumnOwnershipError (corpus consistency).
//   * The dual-write shape has one slot per vector column, so later tiers that
//     map to an already-assigned column are dropped with a warning; a third
//     tier matters when the second is absent or unusable.
export function resolveAdminEmbeddingLadder(
  primary: EmbeddingSelection | null,
  fallback: EmbeddingSelection | null,
  fallback2: EmbeddingSelection | null,
  catalog: EmbeddingModelCatalogRow[],
  columnOwners: ColumnOwners,
  readEnvironment: EnvironmentReader = Deno.env.get,
): DualEmbeddingConfig {
  const tiers = [primary, fallback, fallback2].filter(
    (tier): tier is EmbeddingSelection =>
      !!tier && typeof tier.provider_code === "string" && typeof tier.model_id === "string",
  );
  if (!tiers.length) {
    const envDual = resolveDualEmbeddingConfig(readEnvironment);
    // Owner rows only exist once this ladder has written a corpus; when they
    // do, the env default may no longer be the owner and must be refused too.
    assertSelectionOwnsColumns([envDual.primary, envDual.fallback].filter(Boolean) as EmbeddingConfig[], columnOwners);
    return envDual;
  }

  const byKey = new Map(
    catalog.map((row) => [`${row.provider_code}/${row.model_id}`, row]),
  );
  const configs: EmbeddingConfig[] = [];
  for (const tier of tiers) {
    const row = byKey.get(`${tier.provider_code}/${tier.model_id}`);
    if (!row || !row.is_active || !row.capabilities?.includes("embedding")) {
      console.warn(
        `[knowledge-embeddings] ignoring embedding tier ${tier.provider_code}/${tier.model_id}: not an active embedding model`,
      );
      continue;
    }
    const width = recordedEmbeddingWidth(row.metadata);
    if (width === null) {
      console.warn(
        `[knowledge-embeddings] ignoring embedding tier ${tier.provider_code}/${tier.model_id}: no dimensionality recorded`,
      );
      continue;
    }
    if (!isStorableWidth(width)) {
      throw new UnstorableEmbeddingWidthError(tier, width);
    }
    const config = selectionConfig(tier, width, readEnvironment);
    if (configs.some((existing) => existing.column === config.column)) {
      console.warn(
        `[knowledge-embeddings] dropping embedding tier ${tier.provider_code}/${tier.model_id}: column ${config.column} already assigned this run`,
      );
      continue;
    }
    configs.push(config);
  }

  if (!configs.length) {
    const envDual = resolveDualEmbeddingConfig(readEnvironment);
    assertSelectionOwnsColumns([envDual.primary, envDual.fallback].filter(Boolean) as EmbeddingConfig[], columnOwners);
    return envDual;
  }
  assertSelectionOwnsColumns(configs, columnOwners);
  return { primary: configs[0], fallback: configs[1] ?? null };
}

function parseSelection(value: unknown): EmbeddingSelection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.provider_code !== "string" || typeof record.model_id !== "string") {
    return null;
  }
  return { provider_code: record.provider_code, model_id: record.model_id };
}

type SettingsClient = {
  from: (table: string) => any;
};

async function readSettingRows(
  admin: SettingsClient,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  try {
    const { data } = await admin.from("system_settings")
      .select("key, value")
      .in("key", [...keys]);
    return new Map((data || []).map((row: { key: string; value: unknown }) => [row.key, row.value]));
  } catch (error) {
    // A settings read failure degrades to the env default, mirroring
    // fetchCategoryAiSettings: the ladder must hard-fail only on genuinely
    // inconsistent selections, not on a transient read error.
    console.warn(
      "[knowledge-embeddings] system_settings read failed; using env defaults:",
      error instanceof Error ? error.message : String(error),
    );
    return new Map();
  }
}

async function readColumnOwners(admin: SettingsClient): Promise<ColumnOwners> {
  const columns = ["embedding", "embedding_bge_m3"] as const;
  const keys = columns.map(columnOwnerKey);
  const rows = await readSettingRows(admin, keys);
  const owners: ColumnOwners = {};
  for (const column of columns) {
    const selection = parseSelection(rows.get(columnOwnerKey(column)));
    if (selection) owners[column] = `${selection.provider_code}/${selection.model_id}`;
  }
  return owners;
}

async function readModelCatalog(
  admin: SettingsClient,
  selections: EmbeddingSelection[],
): Promise<EmbeddingModelCatalogRow[]> {
  const modelIds = [...new Set(selections.map((selection) => selection.model_id))];
  if (!modelIds.length) return [];
  try {
    const { data } = await admin.from("ai_models")
      .select("model_id, is_active, capabilities, metadata, ai_providers!inner(provider_code, is_active)")
      .in("model_id", modelIds);
    return (data || [])
      .filter((row: any) => row.ai_providers?.is_active)
      .map((row: any) => ({
        provider_code: row.ai_providers.provider_code as string,
        model_id: row.model_id as string,
        is_active: Boolean(row.is_active),
        capabilities: (row.capabilities || []) as string[],
        metadata: row.metadata,
      }));
  } catch (error) {
    console.warn(
      "[knowledge-embeddings] ai_models read failed; treating selections as unknown:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

// Admin selection first, env behaviour when the selection is absent or unusable.
// Callers: ai-knowledge-ingest, ai-knowledge-excel-worker (ingest) and
// ai-agent-reply (RAG retrieval). All three must resolve identically or query
// vectors stop being comparable with stored vectors.
export async function resolveDualEmbeddingConfigFromDb(
  admin: SettingsClient,
  readEnvironment: EnvironmentReader = Deno.env.get,
): Promise<DualEmbeddingConfig> {
  const settingRows = await readSettingRows(admin, EMBEDDING_SETTING_KEYS);
  const [columnOwners, catalog] = await Promise.all([
    readColumnOwners(admin),
    readModelCatalog(
      admin,
      EMBEDDING_SETTING_KEYS
        .map((key) => parseSelection(settingRows.get(key)))
        .filter((selection): selection is EmbeddingSelection => selection !== null),
    ),
  ]);
  return resolveAdminEmbeddingLadder(
    parseSelection(settingRows.get("default_ai_model_embedding")),
    parseSelection(settingRows.get("default_ai_model_embedding_fallback")),
    parseSelection(settingRows.get("default_ai_model_embedding_fallback_2")),
    catalog,
    columnOwners,
    readEnvironment,
  );
}

// First successful write into a vector column claims it for that model. The
// claim is never overwritten (ignoreDuplicates), so a corpus keeps one owner
// until it is deleted; resolution above refuses a mismatched successor.
export async function claimEmbeddingColumnOwnership(
  admin: SettingsClient,
  dual: DualEmbeddingConfig,
): Promise<void> {
  for (const config of [dual.primary, dual.fallback]) {
    if (!config) continue;
    const { error } = await admin.from("system_settings").upsert(
      {
        key: columnOwnerKey(config.column),
        value: { provider_code: config.provider, model_id: config.model },
        description: `Model that produced the vectors in ai_knowledge_chunks.${config.column}`,
      },
      { onConflict: "key", ignoreDuplicates: true },
    );
    if (error) {
      // Ownership is a safety net, not a prerequisite: failing the ingest after
      // the vectors landed would strand a ready source over bookkeeping.
      console.warn(
        `[knowledge-embeddings] could not record ownership of ${config.column}: ${error.message}`,
      );
    }
  }
}

// OpenAI, OpenRouter and Gemini all speak the same /embeddings dialect (Bearer
// auth, batched `input`, requested `dimensions`) — Gemini through its
// OpenAI-compatible endpoint. One caller keeps a third copy of the batching and
// width-checking from drifting away from the other two.
/**
 * How long to wait before retrying a failed embedding call, or null when the
 * status is not worth retrying (a bad key or a malformed request stays bad).
 *
 * A 429 is a per-minute token bucket on the hosted providers (Jina: 100k
 * tokens/min on the free key, measured 2026-09-05), so it waits long enough
 * for a meaningful share of the bucket to refill rather than the sub-second
 * backoff that suits a flaky network. Two retries keep the worst case (~36s)
 * inside the standalone worker's patience and the edge ingest's 60s ceiling.
 */
export function embeddingRetryDelayMs(status: number, attempt: number): number | null {
  if (status === 429) return 12_000 * (attempt + 1);
  if (status === 0 || status === 408 || status >= 500) return 500 * 2 ** attempt;
  return null;
}

/** fetch rejects with a TypeError; AbortSignal.timeout with a TimeoutError; a non-JSON body with a SyntaxError. */
function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof SyntaxError ||
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"));
}

const EMBED_ATTEMPTS = 3;

type OpenAiCompatibleApi = {
  endpoint: string;
  keyEnvVar: string;
  label: string;
  /** Provider-specific fields sent alongside the standard body. */
  extraBody?: Record<string, unknown>;
};

/** Exported for tests only; production goes through embedKnowledge. */
export async function embedWithOpenAiCompatible(
  texts: string[],
  config: EmbeddingConfig,
  api: OpenAiCompatibleApi,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<number[][]> {
  const key = Deno.env.get(api.keyEnvVar);
  if (!key) throw new Error(`${api.keyEnvVar} is not configured`);

  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += 64) {
    const body = JSON.stringify({
      model: config.model,
      input: texts.slice(start, start + 64),
      dimensions: config.dimensions,
      ...api.extraBody,
    });
    let payload: { data?: Array<{ embedding?: unknown }> } = {};
    for (let attempt = 0; attempt < EMBED_ATTEMPTS; attempt += 1) {
      // A dropped connection, the 15s timeout, or a non-JSON error page are
      // as transient as a 503 and take the same bounded retry; they are
      // reported as HTTP 0 so the message still says what was seen.
      let status = 0;
      try {
        const response = await fetch(api.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        payload = await response.json();
        if (response.ok && Array.isArray(payload.data)) break;
      } catch (error) {
        if (!isTransportFailure(error)) throw error;
      }
      const delay = embeddingRetryDelayMs(status, attempt);
      if (delay === null || attempt === EMBED_ATTEMPTS - 1) {
        // The status is the only clue between a bad key (401), an exhausted
        // quota (402/429) and an outage; without it every failure reads alike.
        throw new Error(`${api.label} embedding request failed (HTTP ${status})`);
      }
      console.warn(`[knowledge-embeddings] ${api.label} returned HTTP ${status}; retrying in ${delay}ms`);
      await sleep(delay);
    }
    if (!Array.isArray(payload.data)) {
      throw new Error(`${api.label} embedding request failed`);
    }

    const batch: unknown[] = payload.data.map((item) => item.embedding);
    if (
      batch.length !== Math.min(64, texts.length - start) ||
      !batch.every((embedding: unknown) =>
        Array.isArray(embedding) && embedding.length === config.dimensions,
      )
    ) {
      throw new Error(`${api.label} returned an unexpected embedding dimension`);
    }
    embeddings.push(...batch as number[][]);
  }
  return embeddings;
}

function embedWithOpenAI(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  return embedWithOpenAiCompatible(texts, config, {
    endpoint: OPENAI_ENDPOINT,
    keyEnvVar: "OPENAI_API_KEY",
    label: "OpenAI",
  });
}

function embedWithOpenRouter(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  return embedWithOpenAiCompatible(texts, config, {
    endpoint: OPENROUTER_ENDPOINT,
    keyEnvVar: "OPENROUTER_API_KEY",
    label: "OpenRouter",
  });
}

function embedWithVercel(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  return embedWithOpenAiCompatible(texts, config, {
    endpoint: VERCEL_ENDPOINT,
    keyEnvVar: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
  });
}

// GEMINI_ENDPOINT is Google's OpenAI-compatible route, so Bearer auth is
// correct here. The native generativelanguage route rejects Bearer and wants an
// x-goog-api-key header instead — do not "fix" one into the other.
function embedWithGemini(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  return embedWithOpenAiCompatible(texts, config, {
    endpoint: GEMINI_ENDPOINT,
    keyEnvVar: "GOOGLE_AI_STUDIO_KEY",
    label: "Gemini",
  });
}

function embedWithJina(
  texts: string[],
  config: EmbeddingConfig,
  purpose: EmbeddingPurpose,
): Promise<number[][]> {
  return embedWithOpenAiCompatible(texts, config, {
    endpoint: JINA_ENDPOINT,
    keyEnvVar: "JINA_API_KEY",
    label: "Jina",
    extraBody: {
      task: purpose === "query" ? "retrieval.query" : "retrieval.passage",
      normalized: true,
      truncate: true,
    },
  });
}

export async function embedKnowledge(
  texts: string[],
  config: EmbeddingConfig = resolveEmbeddingConfig(),
  purpose: EmbeddingPurpose = "passage",
): Promise<number[][]> {
  if (!texts.length) return [];
  if (config.provider === "gemini") return embedWithGemini(texts, config);
  if (config.provider === "openai") return embedWithOpenAI(texts, config);
  if (config.provider === "openrouter") return embedWithOpenRouter(texts, config);
  if (config.provider === "jina") return embedWithJina(texts, config, purpose);
  if (config.provider === "vercel") return embedWithVercel(texts, config);
  if (config.provider === "ollama") {
    return embedWithOllama(texts, { baseUrl: config.ollamaBaseUrl, model: config.model });
  }
  // Reached only by a config built outside selectionConfig; sending an unknown
  // provider's model id to Ollama would fail one call later with a misleading
  // "fallback embed failed" instead of naming the real gap.
  throw new Error(`No embedding caller for provider ${config.provider}`);
}

export type DualEmbeddings = {
  primary: number[][];
  fallback: number[][] | null;
};

// Embed once per configured provider so both vector columns are populated at
// ingest. The primary is required (an outage there fails the ingest); the
// fallback is best-effort — a fallback-provider outage logs and stores the
// primary only, so that chunk simply has no failover vector.
export async function embedKnowledgeDual(
  texts: string[],
  dual: DualEmbeddingConfig,
  embed: Embedder = embedKnowledge,
): Promise<DualEmbeddings> {
  if (!dual.fallback) return { primary: await embed(texts, dual.primary), fallback: null };
  // Both providers run at once: the fallback (CPU-only Ollama, ~20s for a
  // batch of prose chunks) dominates the batch, and running the primary
  // after it instead of alongside it was pure added latency inside a 60s isolate.
  const [primary, fallback] = await Promise.all([
    embed(texts, dual.primary),
    embed(texts, dual.fallback).catch((error: unknown) => {
      console.warn(
        "[knowledge-embeddings] fallback embed failed; storing primary vectors only:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }),
  ]);
  return { primary, fallback };
}

// Column/value record for a single chunk, carrying both providers' vectors when
// the fallback embed succeeded.
export function dualEmbeddingRecord(
  dual: DualEmbeddingConfig,
  embeddings: DualEmbeddings,
  index: number,
): Record<string, number[]> {
  const record: Record<string, number[]> = embeddingRecord(dual.primary, embeddings.primary[index]);
  if (dual.fallback && embeddings.fallback) {
    Object.assign(record, embeddingRecord(dual.fallback, embeddings.fallback[index]));
  }
  return record;
}

export type KnowledgeChunkMatch = {
  id: string;
  source_id?: string;
  content: string;
  metadata?: unknown;
  similarity: number;
};

export type RetrievalRpc = (
  name: string,
  params: { query_embedding: number[]; p_user_id: string; match_count: number },
) => Promise<{ data: unknown; error: unknown }>;

// Embedder seam so retrieval failover can be tested without a live provider;
// production always uses the real embedKnowledge.
export type Embedder = (
  texts: string[],
  config: EmbeddingConfig,
  purpose?: EmbeddingPurpose,
) => Promise<number[][]>;

/** What to retrieve, and whose agent is asking. */
export interface KnowledgeRetrievalRequest {
  userId: string;
  /**
   * The connected account the reply is being written for. Retrieval is scoped
   * to the sources linked to it, so one login's brands cannot read each
   * other's knowledge base. Omitted only by callers with no account context,
   * which fall back to the user-wide matchers.
   */
  socialAccountId?: string | null;
  query: string;
  matchCount: number;
}

async function embedAndMatch(
  rpc: RetrievalRpc,
  request: KnowledgeRetrievalRequest,
  config: EmbeddingConfig,
  embed: Embedder,
): Promise<KnowledgeChunkMatch[]> {
  const [embedding] = await embed([request.query], config, "query");
  const scoped = !!request.socialAccountId;
  const { data, error } = await rpc(
    scoped ? accountRetrievalRpcName(config) : retrievalRpcName(config),
    {
      query_embedding: embedding,
      p_user_id: request.userId,
      ...(scoped ? { p_social_account_id: request.socialAccountId } : {}),
      match_count: request.matchCount,
    },
  );
  if (error) throw error;
  return (data || []) as KnowledgeChunkMatch[];
}

// Retrieve with the primary provider; on a primary *error* (embed failure or
// RPC error) fail over to the fallback provider's vector column. Empty results
// are a valid answer, not a failure, so they never trigger failover.
export async function retrieveKnowledgeChunks(
  rpc: RetrievalRpc,
  request: KnowledgeRetrievalRequest,
  dual: DualEmbeddingConfig,
  embed: Embedder = embedKnowledge,
): Promise<KnowledgeChunkMatch[]> {
  try {
    return await embedAndMatch(rpc, request, dual.primary, embed);
  } catch (primaryError) {
    if (!dual.fallback) throw primaryError;
    console.warn(
      "[knowledge-embeddings] primary retrieval failed; using fallback provider:",
      primaryError instanceof Error ? primaryError.message : String(primaryError),
    );
    return await embedAndMatch(rpc, request, dual.fallback, embed);
  }
}
