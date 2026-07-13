export const EMBEDDING_MODEL = "bge-m3:latest";
export const EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434";
// Ollama runs CPU-only on a shared, often CPU-saturated host, so per-request
// latency is spiky. Keep batches small (~a few seconds each even under load)
// and the timeout very forgiving so one slow batch can't fail a whole workbook;
// the worker is a standalone process with no edge wall-clock limit.
export const EMBED_BATCH_SIZE = 8;
const EMBED_TIMEOUT_MS = 120_000;
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

// A network error or timeout worth retrying. AbortSignal.timeout() raises a
// DOMException named "TimeoutError" (not "AbortError"), so both must be listed
// or a slow request would fail on the first attempt instead of retrying.
function retryableNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

async function embedBatch(
  texts: string[],
  baseUrl: string,
  model: string,
  fetcher: Fetcher,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number[][]> {
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
      if (!retryableNetworkError(error) || attempt === MAX_ATTEMPTS - 1) {
        if (retryableNetworkError(error)) {
          throw new Error("Ollama embedding request failed after retries");
        }
        throw error;
      }
    }
    await waitBeforeRetry(attempt, sleep);
  }

  throw new Error("Ollama embedding request failed after retries");
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

  // Embed in bounded batches so a large workbook can't exceed a single
  // request's timeout; each batch keeps the model warm for the next.
  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    embeddings.push(...await embedBatch(batch, baseUrl, model, fetcher, sleep));
  }
  return embeddings;
}
