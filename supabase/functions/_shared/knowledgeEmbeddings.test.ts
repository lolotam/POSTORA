import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type DualEmbeddingConfig,
  dualEmbeddingRecord,
  type EmbeddingConfig,
  embeddingRecord,
  resolveDualEmbeddingConfig,
  resolveEmbeddingConfig,
  retrievalRpcName,
  retrieveKnowledgeChunks,
} from "./knowledgeEmbeddings.ts";

const env = (pairs: Record<string, string>) => (name: string) => pairs[name];

Deno.test("default embedding configuration preserves Gemini's legacy vector space", () => {
  const config = resolveEmbeddingConfig(() => undefined);

  assertEquals(config.provider, "gemini");
  assertEquals(config.column, "embedding");
  assertEquals(config.dimensions, 1536);
  assertEquals(retrievalRpcName(config), "match_ai_knowledge_chunks");
});

Deno.test("Ollama pilot configuration targets only the bge-m3 vector column", () => {
  const values = new Map([
    ["EMBEDDING_PROVIDER", "ollama"],
    ["EMBEDDING_COLUMN", "embedding_bge_m3"],
    ["EMBEDDING_DIMENSIONS", "1024"],
  ]);
  const config = resolveEmbeddingConfig((name) => values.get(name));

  const record = embeddingRecord(config, Array.from({ length: 1024 }, () => 0.1));

  assertEquals(config.provider, "ollama");
  assertEquals(record.embedding_bge_m3.length, 1024);
  assertEquals(retrievalRpcName(config), "match_ai_knowledge_chunks_bge_m3");
});

Deno.test("provider and vector column mismatches are rejected before an insert record is created", () => {
  const values = new Map([
    ["EMBEDDING_PROVIDER", "ollama"],
    ["EMBEDDING_COLUMN", "embedding"],
    ["EMBEDDING_DIMENSIONS", "1024"],
  ]);

  assertThrows(
    () => resolveEmbeddingConfig((name) => values.get(name)),
    Error,
    "requires EMBEDDING_COLUMN=embedding_bge_m3",
  );
});

Deno.test("wrong-dimension vectors are rejected before a database record is created", () => {
  const values = new Map([
    ["EMBEDDING_PROVIDER", "ollama"],
    ["EMBEDDING_COLUMN", "embedding_bge_m3"],
    ["EMBEDDING_DIMENSIONS", "1024"],
  ]);
  const config = resolveEmbeddingConfig((name) => values.get(name));

  assertThrows(
    () => embeddingRecord(config, Array.from({ length: 1536 }, () => 0.1)),
    Error,
    "expected 1024 dimensions",
  );
});

Deno.test("no fallback provider configured leaves dual retrieval single-provider", () => {
  const dual = resolveDualEmbeddingConfig(env({ EMBEDDING_PROVIDER: "ollama" }));

  assertEquals(dual.primary.provider, "ollama");
  assertEquals(dual.fallback, null);
});

Deno.test("ollama primary with gemini fallback resolves both vector columns", () => {
  const dual = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_FALLBACK_PROVIDER: "gemini" }),
  );

  assertEquals(dual.primary.column, "embedding_bge_m3");
  assertEquals(dual.fallback?.column, "embedding");
  assertEquals(dual.fallback?.dimensions, 1536);
});

Deno.test("a fallback provider equal to the primary is rejected", () => {
  assertThrows(
    () =>
      resolveDualEmbeddingConfig(
        env({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_FALLBACK_PROVIDER: "ollama" }),
      ),
    Error,
    "must differ",
  );
});

Deno.test("dual embedding record carries both providers' vectors when the fallback embedded", () => {
  const dual: DualEmbeddingConfig = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_FALLBACK_PROVIDER: "gemini" }),
  );
  const record = dualEmbeddingRecord(dual, {
    primary: [Array.from({ length: 1024 }, () => 0.1)],
    fallback: [Array.from({ length: 1536 }, () => 0.2)],
  }, 0);

  assertEquals(record.embedding_bge_m3.length, 1024);
  assertEquals(record.embedding.length, 1536);
});

Deno.test("dual embedding record stores primary only when the fallback embed was skipped", () => {
  const dual: DualEmbeddingConfig = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_FALLBACK_PROVIDER: "gemini" }),
  );
  const record = dualEmbeddingRecord(dual, {
    primary: [Array.from({ length: 1024 }, () => 0.1)],
    fallback: null,
  }, 0);

  assertEquals(record.embedding_bge_m3.length, 1024);
  assertEquals("embedding" in record, false);
});

const okRpc = (rows: unknown[]) => (_name: string) =>
  Promise.resolve({ data: rows, error: null });

Deno.test("retrieval empty results do not trigger a fallback embed", async () => {
  const dual = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_FALLBACK_PROVIDER: "gemini" }),
  );
  const providersUsed: string[] = [];
  const chunks = await retrieveKnowledgeChunks(
    okRpc([]),
    "user-1",
    "query",
    6,
    dual,
    (_texts: string[], config: EmbeddingConfig) => {
      providersUsed.push(config.provider);
      return Promise.resolve([[0.1]]);
    },
  );

  assertEquals(chunks, []);
  assertEquals(providersUsed, ["ollama"]);
});

Deno.test("retrieval fails over to the fallback provider when the primary embed throws", async () => {
  const dual = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_FALLBACK_PROVIDER: "gemini" }),
  );
  const rpcNames: string[] = [];
  const chunks = await retrieveKnowledgeChunks(
    (name: string) => {
      rpcNames.push(name);
      return Promise.resolve({ data: [{ id: "x", content: "hit", similarity: 0.9 }], error: null });
    },
    "user-1",
    "query",
    6,
    dual,
    (_texts: string[], config: EmbeddingConfig) => {
      if (config.provider === "ollama") throw new Error("ollama down");
      return Promise.resolve([[0.2]]);
    },
  );

  assertEquals(rpcNames, ["match_ai_knowledge_chunks"]);
  assertEquals(chunks[0].id, "x");
});
