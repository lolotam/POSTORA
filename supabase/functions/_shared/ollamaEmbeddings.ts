export const EMBEDDING_MODEL = "bge-m3:latest";
export const EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434";
const EMBED_TIMEOUT_MS = 15_000;

type OllamaEmbedResponse = {
  embeddings?: unknown;
};

export function parseOllamaEmbeddings(
  payload: OllamaEmbedResponse,
  expectedCount: number,
): number[][] {
  if (
    !Array.isArray(payload.embeddings) ||
    payload.embeddings.length !== expectedCount
  ) {
    throw new Error("Ollama returned an unexpected number of embeddings");
  }

  return payload.embeddings.map((embedding) => {
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMENSIONS ||
      !embedding.every((value) => typeof value === "number")
    ) {
      throw new Error(
        `Ollama embedding expected ${EMBEDDING_DIMENSIONS} dimensions`,
      );
    }
    return embedding;
  });
}

export async function embedWithOllama(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];

  const baseUrl = (Deno.env.get("OLLAMA_BASE_URL") || DEFAULT_OLLAMA_BASE_URL)
    .replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || "Ollama embedding request failed");
  }
  return parseOllamaEmbeddings(payload, texts.length);
}
