export const EMBEDDING_MODEL = "bge-m3:latest";
export const EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434";
const EMBED_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

type Fetcher = typeof fetch;

export type OllamaEmbeddingOptions = {
  baseUrl?: string;
  model?: string;
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
};

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

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function waitBeforeRetry(
  attempt: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  await sleep(250 * 2 ** attempt);
}

export async function embedWithOllama(
  texts: string[],
  options: OllamaEmbeddingOptions = {},
): Promise<number[][]> {
  if (!texts.length) return [];

  const baseUrl = (options.baseUrl || Deno.env.get("OLLAMA_BASE_URL") || DEFAULT_OLLAMA_BASE_URL)
    .replace(/\/$/, "");
  const model = options.model || EMBEDDING_MODEL;
  const fetcher = options.fetcher || fetch;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetcher(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts, keep_alive: "30m" }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (response.ok) {
        return parseOllamaEmbeddings(await response.json(), texts.length);
      }
      if (!retryableStatus(response.status) || attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`Ollama embedding request failed (HTTP ${response.status})`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("expected")) throw error;
      const retryableNetworkError =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "AbortError");
      if (!retryableNetworkError) throw error;
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new Error("Ollama embedding request failed after retries");
      }
    }
    await waitBeforeRetry(attempt, sleep);
  }

  throw new Error("Ollama embedding request failed after retries");
}
