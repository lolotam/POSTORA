import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedWithOllama,
  parseOllamaEmbeddings,
} from "./ollamaEmbeddings.ts";

const vector = (value: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);

Deno.test("parseOllamaEmbeddings accepts one 1024-dimension vector per input", () => {
  const embeddings = parseOllamaEmbeddings(
    { embeddings: [vector(0.1), vector(0.2)] },
    2,
  );

  assertEquals(EMBEDDING_DIMENSIONS, 1024);
  assertEquals(embeddings.length, 2);
  assertEquals(embeddings[0].length, 1024);
  assertEquals(embeddings[1][0], 0.2);
});

Deno.test("parseOllamaEmbeddings rejects a vector with the wrong dimension", () => {
  assertThrows(
    () => parseOllamaEmbeddings({ embeddings: [[0.1, 0.2]] }, 1),
    Error,
    "expected 1024 dimensions",
  );
});

Deno.test("embedWithOllama sends every input to bge-m3 and returns its vectors", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: { model?: string; input?: string[] } | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ embeddings: [vector(0.3)] });
  };

  try {
    const embeddings = await embedWithOllama(["مرحبا"]);

    assertEquals(requestBody, { model: EMBEDDING_MODEL, input: ["مرحبا"] });
    assertEquals(embeddings[0][0], 0.3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
