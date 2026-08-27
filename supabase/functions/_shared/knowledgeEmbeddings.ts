import {
  EMBEDDING_DIMENSIONS as OLLAMA_DIMENSIONS,
  EMBEDDING_MODEL as DEFAULT_OLLAMA_MODEL,
  embedWithOllama,
} from "./ollamaEmbeddings.ts";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";
const GEMINI_MODEL = "gemini-embedding-001";
const GEMINI_DIMENSIONS = 1536;

export type EmbeddingProvider = "gemini" | "ollama";
export type EnvironmentReader = (name: string) => string | undefined;

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  column: "embedding" | "embedding_bge_m3";
  dimensions: number;
  model: string;
  ollamaBaseUrl?: string;
};

function configuredValue(
  readEnvironment: EnvironmentReader,
  name: string,
  fallback: string,
): string {
  return readEnvironment(name)?.trim() || fallback;
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

export function retrievalRpcName(config: EmbeddingConfig): string {
  return config.provider === "gemini"
    ? "match_ai_knowledge_chunks"
    : "match_ai_knowledge_chunks_bge_m3";
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

async function embedWithGemini(texts: string[]): Promise<number[][]> {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!key) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");

  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += 64) {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: texts.slice(start, start + 64),
        dimensions: GEMINI_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload: { data?: Array<{ embedding?: unknown }> } = await response.json();
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error("Gemini embedding request failed");
    }

    const batch: unknown[] = payload.data.map((item) => item.embedding);
    if (
      batch.length !== Math.min(64, texts.length - start) ||
      !batch.every((embedding: unknown) =>
        Array.isArray(embedding) && embedding.length === GEMINI_DIMENSIONS,
      )
    ) {
      throw new Error("Gemini returned an unexpected embedding dimension");
    }
    embeddings.push(...batch as number[][]);
  }
  return embeddings;
}

export async function embedKnowledge(
  texts: string[],
  config: EmbeddingConfig = resolveEmbeddingConfig(),
): Promise<number[][]> {
  if (!texts.length) return [];
  if (config.provider === "gemini") return embedWithGemini(texts);

  return embedWithOllama(texts, {
    baseUrl: config.ollamaBaseUrl,
    model: config.model,
  });
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
): Promise<DualEmbeddings> {
  const primary = await embedKnowledge(texts, dual.primary);
  if (!dual.fallback) return { primary, fallback: null };
  try {
    return { primary, fallback: await embedKnowledge(texts, dual.fallback) };
  } catch (error) {
    console.warn(
      "[knowledge-embeddings] fallback embed failed; storing primary vectors only:",
      error instanceof Error ? error.message : String(error),
    );
    return { primary, fallback: null };
  }
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
export type Embedder = (texts: string[], config: EmbeddingConfig) => Promise<number[][]>;

async function embedAndMatch(
  rpc: RetrievalRpc,
  userId: string,
  query: string,
  matchCount: number,
  config: EmbeddingConfig,
  embed: Embedder,
): Promise<KnowledgeChunkMatch[]> {
  const [embedding] = await embed([query], config);
  const { data, error } = await rpc(retrievalRpcName(config), {
    query_embedding: embedding,
    p_user_id: userId,
    match_count: matchCount,
  });
  if (error) throw error;
  return (data || []) as KnowledgeChunkMatch[];
}

// Retrieve with the primary provider; on a primary *error* (embed failure or
// RPC error) fail over to the fallback provider's vector column. Empty results
// are a valid answer, not a failure, so they never trigger failover.
export async function retrieveKnowledgeChunks(
  rpc: RetrievalRpc,
  userId: string,
  query: string,
  matchCount: number,
  dual: DualEmbeddingConfig,
  embed: Embedder = embedKnowledge,
): Promise<KnowledgeChunkMatch[]> {
  try {
    return await embedAndMatch(rpc, userId, query, matchCount, dual.primary, embed);
  } catch (primaryError) {
    if (!dual.fallback) throw primaryError;
    console.warn(
      "[knowledge-embeddings] primary retrieval failed; using fallback provider:",
      primaryError instanceof Error ? primaryError.message : String(primaryError),
    );
    return await embedAndMatch(rpc, userId, query, matchCount, dual.fallback, embed);
  }
}
