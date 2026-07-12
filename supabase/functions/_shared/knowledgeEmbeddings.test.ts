import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  embeddingRecord,
  resolveEmbeddingConfig,
  retrievalRpcName,
} from "./knowledgeEmbeddings.ts";

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
