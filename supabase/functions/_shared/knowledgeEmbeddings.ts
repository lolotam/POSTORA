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
  const provider = configuredValue(readEnvironment, "EMBEDDING_PROVIDER", "gemini");

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
