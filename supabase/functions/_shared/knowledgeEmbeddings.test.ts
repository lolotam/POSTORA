import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type DualEmbeddingConfig,
  dualEmbeddingRecord,
  type EmbeddingConfig,
  type EmbeddingModelCatalogRow,
  embeddingRecord,
  embedKnowledgeDual,
  embedWithOpenAiCompatible,
  embedWithVercel,
  embedKnowledge,
  embeddingProviderKey,
  EmbeddingColumnOwnershipError,
  resolveAdminEmbeddingLadder,
  resolveDualEmbeddingConfig,
  resolveDualEmbeddingConfigFromDb,
  resolveEmbeddingConfig,
  accountRetrievalRpcName,
  retrievalRpcName,
  retrieveKnowledgeChunks,
  UnstorableEmbeddingWidthError,
} from "./knowledgeEmbeddings.ts";

const env = (pairs: Record<string, string>) => (name: string) => pairs[name];

// The env default is the self-hosted Ollama (bge-m3) — this server has no
// Gemini key configured for embeddings. The resolver default was flipped to
// ollama on 2026-08-26; this test pins that "today" so the admin ladder's
// absent-settings fallback has a fixed expectation to preserve.
Deno.test("default embedding configuration stays on the self-hosted Ollama", () => {
  const config = resolveEmbeddingConfig(() => undefined);

  assertEquals(config.provider, "ollama");
  assertEquals(config.column, "embedding_bge_m3");
  assertEquals(config.dimensions, 1024);
  assertEquals(retrievalRpcName(config), "match_ai_knowledge_chunks_bge_m3");
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
    { userId: "user-1", query: "query", matchCount: 6 },
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
  const purposes: Array<string | undefined> = [];
  const chunks = await retrieveKnowledgeChunks(
    (name: string) => {
      rpcNames.push(name);
      return Promise.resolve({ data: [{ id: "x", content: "hit", similarity: 0.9 }], error: null });
    },
    { userId: "user-1", query: "query", matchCount: 6 },
    dual,
    (_texts: string[], config: EmbeddingConfig, purpose) => {
      purposes.push(purpose);
      if (config.provider === "ollama") throw new Error("ollama down");
      return Promise.resolve([[0.2]]);
    },
  );

  assertEquals(rpcNames, ["match_ai_knowledge_chunks"]);
  assertEquals(chunks[0].id, "x");
  // A search string is embedded as a query, not as a stored passage: Jina's
  // asymmetric model scores a passage-embedded query noticeably worse.
  assertEquals(purposes, ["query", "query"]);
});

Deno.test("dual ingest embeds with both providers at once, not one after the other", async () => {
  const dual = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "gemini", EMBEDDING_FALLBACK_PROVIDER: "ollama" }),
  );
  // Neither call resolves until both have started: sequential code would
  // never start the second one and this test would hang rather than pass.
  const started: string[] = [];
  let releaseAll = () => {};
  const gate = new Promise<void>((resolve) => (releaseAll = resolve));
  const result = await embedKnowledgeDual(["a"], dual, async (_texts, config) => {
    started.push(config.provider);
    if (started.length === 2) releaseAll();
    await gate;
    return [[config.provider === "gemini" ? 0.1 : 0.2]];
  });

  assertEquals(started.sort(), ["gemini", "ollama"]);
  assertEquals(result, { primary: [[0.1]], fallback: [[0.2]] });
});

/** Runs `body` with fetch and the provider key stubbed, restoring both after. */
async function withStubbedProvider(
  responses: Array<{ status: number; body: unknown }>,
  body: () => Promise<void>,
): Promise<number> {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  }) as typeof fetch;
  Deno.env.set("TEST_EMBED_KEY", "k");
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("TEST_EMBED_KEY");
  }
  return calls;
}

const stubbedApi = { endpoint: "https://provider.test/embeddings", keyEnvVar: "TEST_EMBED_KEY", label: "Stub" };
const stubbedConfig: EmbeddingConfig = { provider: "jina", column: "embedding_bge_m3", dimensions: 2, model: "m" };
const okBody = { data: [{ embedding: [0.1, 0.2] }] };

Deno.test("a rate-limited embedding call waits for the token bucket and succeeds on retry", async () => {
  // Jina's free key allows 100k tokens/min; the 2026-09-05 backfill hit 429
  // on its third call. The retry must wait seconds, not milliseconds.
  const waits: number[] = [];
  let result: number[][] = [];
  const calls = await withStubbedProvider(
    [{ status: 429, body: { detail: "Token rate limit exceeded" } }, { status: 200, body: okBody }],
    async () => {
      result = await embedWithOpenAiCompatible(["a"], stubbedConfig, stubbedApi, (ms) => {
        waits.push(ms);
        return Promise.resolve();
      });
    },
  );
  assertEquals(calls, 2);
  assertEquals(waits, [12_000]);
  assertEquals(result, [[0.1, 0.2]]);
});

Deno.test("a rejected key is not retried", async () => {
  const waits: number[] = [];
  const calls = await withStubbedProvider(
    [{ status: 401, body: { detail: "bad key" } }],
    async () => {
      await assertRejects(
        () => embedWithOpenAiCompatible(["a"], stubbedConfig, stubbedApi, (ms) => {
          waits.push(ms);
          return Promise.resolve();
        }),
        Error,
        "HTTP 401",
      );
    },
  );
  assertEquals(calls, 1);
  assertEquals(waits, []);
});

Deno.test("a dropped connection is retried like a 5xx and reported as HTTP 0 if it persists", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.reject(new TypeError("connection reset"));
  }) as typeof fetch;
  Deno.env.set("TEST_EMBED_KEY", "k");
  const waits: number[] = [];
  try {
    await assertRejects(
      () => embedWithOpenAiCompatible(["a"], stubbedConfig, stubbedApi, (ms) => {
        waits.push(ms);
        return Promise.resolve();
      }),
      Error,
      "HTTP 0",
    );
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("TEST_EMBED_KEY");
  }
  assertEquals(calls, 3);
  assertEquals(waits, [500, 1000]);
});

Deno.test("a provider that stays rate-limited fails after the last attempt with the status", async () => {
  const calls = await withStubbedProvider(
    [{ status: 429, body: {} }],
    async () => {
      await assertRejects(
        () => embedWithOpenAiCompatible(["a"], stubbedConfig, stubbedApi, () => Promise.resolve()),
        Error,
        "HTTP 429",
      );
    },
  );
  assertEquals(calls, 3);
});

/** The JSON body of the single request `embed` sends. */
async function sentBody(embed: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Promise.resolve(new Response(JSON.stringify(okBody), { status: 200 }));
  }) as typeof fetch;
  Deno.env.set("TEST_EMBED_KEY", "k");
  try {
    await embed();
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("TEST_EMBED_KEY");
  }
  return sent;
}

Deno.test("a fixed-width model is called without `dimensions`, which it would reject", async () => {
  // OpenRouter's thenlper/gte-large, intfloat/e5-large-v2 and baai/bge-large-en-v1.5
  // fail on any `dimensions`, even their native 1024 (measured 2026-09-25).
  const fixed = await sentBody(() =>
    embedWithOpenAiCompatible(["a"], { ...stubbedConfig, fixedWidth: true }, stubbedApi));
  const sized = await sentBody(() => embedWithOpenAiCompatible(["a"], stubbedConfig, stubbedApi));
  assertEquals("dimensions" in fixed, false);
  assertEquals(sized.dimensions, 2);
});

Deno.test("dual ingest keeps the primary vectors when the concurrent fallback embed fails", async () => {
  const dual = resolveDualEmbeddingConfig(
    env({ EMBEDDING_PROVIDER: "gemini", EMBEDDING_FALLBACK_PROVIDER: "ollama" }),
  );
  const result = await embedKnowledgeDual(["a"], dual, (_texts, config) => {
    if (config.provider === "ollama") return Promise.reject(new Error("ollama down"));
    return Promise.resolve([[0.1]]);
  });
  assertEquals(result, { primary: [[0.1]], fallback: null });
});

// ---------------------------------------------------------------------------
// Admin-selected embedding ladder
// ---------------------------------------------------------------------------

function catalogRow(
  providerCode: string,
  modelId: string,
  native: number,
  requested: number = native,
): EmbeddingModelCatalogRow {
  return {
    provider_code: providerCode,
    model_id: modelId,
    is_active: true,
    capabilities: ["embedding"],
    metadata: { embedding_dimensions: { native, requested } },
  };
}

const SEEDED_CATALOG = [
  catalogRow("openai", "text-embedding-3-small", 1536),
  catalogRow("openai", "text-embedding-3-large", 3072, 1536),
  catalogRow("gemini", "gemini-embedding-001", 3072, 1536),
  catalogRow("gemini", "gemini-embedding-2", 3072, 1536),
  catalogRow("gemini", "text-embedding-004", 768),
  catalogRow("ollama", "bge-m3:latest", 1024),
  // 1024 native and refuses a larger `dimensions` (measured 2026-09-05).
  catalogRow("jina", "jina-embeddings-v5-omni-small", 1024),
  // OpenRouter widths below are what the live /embeddings endpoint actually
  // returned when each model was probed, not what its model card advertises.
  catalogRow("openrouter", "perplexity/pplx-embed-v1-4b", 2560, 1536),
  catalogRow("openrouter", "liquid/lfm-2.5-embedding-350m:free", 1024),
  // Vercel AI Gateway speaks the OpenAI embeddings dialect.
  catalogRow("vercel", "openai/text-embedding-3-small", 1536),
];

Deno.test("an OpenRouter selection resolves to the column its returned width fits", () => {
  // OpenRouter was previously refused outright on the belief that it served no
  // embeddings; it does, so a tier naming it must resolve rather than be skipped.
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "openrouter", model_id: "perplexity/pplx-embed-v1-4b" },
    { provider_code: "openrouter", model_id: "liquid/lfm-2.5-embedding-350m:free" },
    null,
    SEEDED_CATALOG,
    {},
  );

  assertEquals(dual.primary.provider, "openrouter");
  assertEquals(dual.primary.column, "embedding");
  assertEquals(dual.primary.dimensions, 1536);
  assertEquals(dual.primary.model, "perplexity/pplx-embed-v1-4b");
  assertEquals(dual.fallback?.column, "embedding_bge_m3");
  assertEquals(dual.fallback?.dimensions, 1024);
});

Deno.test("a catalogue row with no requested width resolves to a fixed-width config", () => {
  const nativeOnly: EmbeddingModelCatalogRow = {
    ...catalogRow("openrouter", "thenlper/gte-large", 1024),
    metadata: { embedding_dimensions: { native: 1024 } },
  };
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "openrouter", model_id: "perplexity/pplx-embed-v1-4b" },
    { provider_code: "openrouter", model_id: "thenlper/gte-large" },
    null,
    [...SEEDED_CATALOG, nativeOnly],
    {},
  );
  assertEquals(dual.primary.fixedWidth, undefined);
  assertEquals(dual.fallback?.fixedWidth, true);
  assertEquals(dual.fallback?.dimensions, 1024);
});

Deno.test("a Vercel selection resolves through the OpenAI-compatible dialect", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "vercel", model_id: "openai/text-embedding-3-small" },
    { provider_code: "ollama", model_id: "bge-m3:latest" },
    null,
    SEEDED_CATALOG,
    {},
  );

  assertEquals(dual.primary.provider, "vercel");
  assertEquals(dual.primary.column, "embedding");
  assertEquals(dual.primary.dimensions, 1536);
  assertEquals(dual.primary.model, "openai/text-embedding-3-small");
  assertEquals(dual.fallback?.column, "embedding_bge_m3");
  assertEquals(dual.fallback?.dimensions, 1024);
});

Deno.test("admin selection is honoured across the two vector columns", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "ollama", model_id: "bge-m3:latest" },
    { provider_code: "gemini", model_id: "gemini-embedding-001" },
    { provider_code: "openai", model_id: "text-embedding-3-small" },
    SEEDED_CATALOG,
    {},
    env({}),
  );

  assertEquals(dual.primary.provider, "ollama");
  assertEquals(dual.primary.column, "embedding_bge_m3");
  assertEquals(dual.primary.dimensions, 1024);
  assertEquals(dual.fallback?.provider, "gemini");
  assertEquals(dual.fallback?.column, "embedding");
  assertEquals(dual.fallback?.dimensions, 1536);
});

Deno.test("a Jina fallback takes the 1024 column beside a Gemini primary", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "gemini", model_id: "gemini-embedding-001" },
    { provider_code: "jina", model_id: "jina-embeddings-v5-omni-small" },
    null,
    SEEDED_CATALOG,
    { embedding: "gemini/gemini-embedding-001" },
    env({}),
  );

  assertEquals(dual.primary.column, "embedding");
  assertEquals(dual.fallback, {
    provider: "jina",
    column: "embedding_bge_m3",
    dimensions: 1024,
    model: "jina-embeddings-v5-omni-small",
  });
});

Deno.test("Jina cannot take over the 1024 column while Ollama still owns it", () => {
  // Replacing Ollama with Jina in the 1024 column is a corpus change: the
  // owner row must be cleared (and the column re-embedded) before the ladder
  // may name Jina, otherwise mixed-model vectors would share one index.
  assertThrows(
    () =>
      resolveAdminEmbeddingLadder(
        { provider_code: "gemini", model_id: "gemini-embedding-001" },
        { provider_code: "jina", model_id: "jina-embeddings-v5-omni-small" },
        null,
        SEEDED_CATALOG,
        { embedding: "gemini/gemini-embedding-001", embedding_bge_m3: "ollama/bge-m3:latest" },
        env({}),
      ),
    EmbeddingColumnOwnershipError,
    "requires re-embedding",
  );
});

Deno.test("second fallback fills in when the first tier is absent", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "ollama", model_id: "bge-m3:latest" },
    null,
    { provider_code: "openai", model_id: "text-embedding-3-small" },
    SEEDED_CATALOG,
    {},
    env({}),
  );

  assertEquals(dual.fallback?.provider, "openai");
  assertEquals(dual.fallback?.column, "embedding");
  assertEquals(retrievalRpcName(dual.fallback!), "match_ai_knowledge_chunks");
});

Deno.test("a third tier mapping to an already-assigned column is dropped", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "openai", model_id: "text-embedding-3-large" },
    { provider_code: "openai", model_id: "text-embedding-3-small" },
    { provider_code: "ollama", model_id: "bge-m3:latest" },
    SEEDED_CATALOG,
    {},
    env({}),
  );

  // text-embedding-3-small shares the 1536 column with 3-large, so the bge-m3
  // tier becomes the fallback and the duplicate-column tier disappears.
  assertEquals(dual.primary.model, "text-embedding-3-large");
  assertEquals(dual.fallback?.model, "bge-m3:latest");
});

Deno.test("absent settings fall back to today's env behaviour", () => {
  // The incident-prevention guarantee: no system_settings rows means the
  // resolver must behave exactly like the env-only path it replaced.
  const fromLadder = resolveAdminEmbeddingLadder(null, null, null, SEEDED_CATALOG, {}, env({}));
  const fromEnv = resolveDualEmbeddingConfig(env({}));

  assertEquals(fromLadder, fromEnv);
});

Deno.test("a stale primary selection (unknown to the catalog) falls back to env", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "openrouter", model_id: "made-up-embed" },
    null,
    null,
    SEEDED_CATALOG,
    {},
    env({}),
  );

  assertEquals(dual, resolveDualEmbeddingConfig(env({})));
});

Deno.test("a selected model whose width fits no column is rejected by name and width", () => {
  assertThrows(
    () =>
      resolveAdminEmbeddingLadder(
        { provider_code: "gemini", model_id: "text-embedding-004" },
        null,
        null,
        SEEDED_CATALOG,
        {},
        env({}),
      ),
    UnstorableEmbeddingWidthError,
    "gemini/text-embedding-004 produces 768-dimensional vectors",
  );
});

Deno.test("a selection changing a column's owning model is refused", () => {
  const err = assertThrows(
    () =>
      resolveAdminEmbeddingLadder(
        { provider_code: "openai", model_id: "text-embedding-3-small" },
        null,
        null,
        SEEDED_CATALOG,
        { embedding: "gemini/gemini-embedding-001" },
        env({}),
      ),
    EmbeddingColumnOwnershipError,
    "requires re-embedding",
  );
  assertEquals(err instanceof Error, true);
  assertEquals((err as Error).message.includes('"embedding"'), true);
  assertEquals((err as Error).message.includes("gemini/gemini-embedding-001"), true);
});

Deno.test("a selection matching the recorded owner resolves normally", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "ollama", model_id: "bge-m3:latest" },
    { provider_code: "gemini", model_id: "gemini-embedding-001" },
    null,
    SEEDED_CATALOG,
    { embedding_bge_m3: "ollama/bge-m3:latest", embedding: "gemini/gemini-embedding-001" },
    env({}),
  );

  assertEquals(dual.primary.model, "bge-m3:latest");
  assertEquals(dual.fallback?.model, "gemini-embedding-001");
});

Deno.test("env default is also refused when it would change a column's owner", () => {
  // Owner rows only exist once the ladder has written a corpus; if the admin
  // selection is later removed, the env default must not silently take over a
  // column it does not own.
  assertThrows(
    () =>
      resolveAdminEmbeddingLadder(null, null, null, SEEDED_CATALOG, {
        embedding_bge_m3: "ollama/bge-m3:latest",
        embedding: "openai/text-embedding-3-small",
      }, env({ EMBEDDING_PROVIDER: "gemini" })),
    EmbeddingColumnOwnershipError,
  );
});

Deno.test("an OpenAI selection resolves to the OpenAI caller and the 1536 column", () => {
  const dual = resolveAdminEmbeddingLadder(
    { provider_code: "openai", model_id: "text-embedding-3-large" },
    { provider_code: "ollama", model_id: "bge-m3:latest" },
    null,
    SEEDED_CATALOG,
    {},
    env({}),
  );

  assertEquals(dual.primary.provider, "openai");
  assertEquals(dual.primary.dimensions, 1536);
  assertEquals(retrievalRpcName(dual.primary), "match_ai_knowledge_chunks");
});

// ---------------------------------------------------------------------------
// resolveDualEmbeddingConfigFromDb against a stubbed admin client
// ---------------------------------------------------------------------------

/** Stub of the supabase boundary: settings rows plus a shaped model catalog. */
function fakeAdmin(
  settingsRows: Array<{ key: string; value: unknown }>,
  modelRows: EmbeddingModelCatalogRow[] = SEEDED_CATALOG,
) {
  const upserts: Array<{ key: string; value: unknown }> = [];
  return {
    upserts,
    from: (table: string) => {
      if (table === "system_settings") {
        return {
          select: () => ({
            in: (_col: string, keys: string[]) =>
              Promise.resolve({ data: settingsRows.filter((row) => keys.includes(row.key)) }),
          }),
          upsert: (row: { key: string; value: unknown }) => {
            upserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select: () => ({
          in: (_col: string, modelIds: string[]) =>
            Promise.resolve({
              data: modelRows
                .filter((row) => modelIds.includes(row.model_id))
                .map((row) => ({
                  model_id: row.model_id,
                  is_active: row.is_active,
                  capabilities: row.capabilities,
                  metadata: row.metadata,
                  ai_providers: { provider_code: row.provider_code, is_active: true },
                })),
            }),
        }),
      };
    },
  };
}

Deno.test("the DB wrapper reads the three embedding keys and honours the primary", async () => {
  const dual = await resolveDualEmbeddingConfigFromDb(fakeAdmin([
    { key: "default_ai_model_embedding", value: { provider_code: "ollama", model_id: "bge-m3:latest" } },
    { key: "default_ai_model_embedding_fallback", value: { provider_code: "gemini", model_id: "gemini-embedding-001" } },
    { key: "default_ai_model_embedding_fallback_2", value: { provider_code: "openai", model_id: "text-embedding-3-small" } },
  ]), env({}));

  assertEquals(dual.primary.provider, "ollama");
  assertEquals(dual.fallback?.provider, "gemini");
});

Deno.test("the DB wrapper with no settings rows returns the env configuration", async () => {
  const fromDb = await resolveDualEmbeddingConfigFromDb(fakeAdmin([]), env({}));
  assertEquals(fromDb, resolveDualEmbeddingConfig(env({})));
});

Deno.test("the DB wrapper refuses a selection that changes a recorded owner", async () => {
  await assertRejects(
    () =>
      resolveDualEmbeddingConfigFromDb(fakeAdmin([
        { key: "default_ai_model_embedding", value: { provider_code: "openai", model_id: "text-embedding-3-small" } },
        { key: "embedding_column_owner_embedding", value: { provider_code: "gemini", model_id: "gemini-embedding-001" } },
      ]), env({})),
    EmbeddingColumnOwnershipError,
    "requires re-embedding",
  );
});


// Scoping the retrieval is the whole point of PR2: a login with several brands
// on one platform must not have one brand's agent answer from another's
// documents. The account only reaches the database through the RPC name and its
// p_social_account_id argument, so those are what these assert.
Deno.test("an account-scoped retrieval calls the account matcher with the account id", async () => {
  const dual = resolveDualEmbeddingConfig(env({ EMBEDDING_PROVIDER: "ollama" }));
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  await retrieveKnowledgeChunks(
    (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return Promise.resolve({ data: [], error: null });
    },
    { userId: "user-1", socialAccountId: "account-9", query: "price list", matchCount: 4 },
    dual,
    () => Promise.resolve([[0.1]]),
  );

  assertEquals(calls[0].name, "match_ai_knowledge_chunks_bge_m3_for_account");
  assertEquals(calls[0].params.p_social_account_id, "account-9");
  assertEquals(calls[0].params.p_user_id, "user-1");
});

// The sandbox and any caller with no account context still work, and must not
// send a null account id to the scoped matcher -- that would match nothing and
// silently answer every question with no knowledge at all.
Deno.test("a retrieval with no account falls back to the user-wide matcher", async () => {
  const dual = resolveDualEmbeddingConfig(env({ EMBEDDING_PROVIDER: "ollama" }));
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  await retrieveKnowledgeChunks(
    (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return Promise.resolve({ data: [], error: null });
    },
    { userId: "user-1", socialAccountId: null, query: "price list", matchCount: 4 },
    dual,
    () => Promise.resolve([[0.1]]),
  );

  assertEquals(calls[0].name, "match_ai_knowledge_chunks_bge_m3");
  assertEquals("p_social_account_id" in calls[0].params, false);
});

Deno.test("accountRetrievalRpcName pairs with each vector column", () => {
  assertEquals(
    accountRetrievalRpcName(resolveDualEmbeddingConfig(env({ EMBEDDING_PROVIDER: "ollama" })).primary),
    "match_ai_knowledge_chunks_bge_m3_for_account",
  );
  assertEquals(
    accountRetrievalRpcName(resolveDualEmbeddingConfig(env({ EMBEDDING_PROVIDER: "gemini" })).primary),
    "match_ai_knowledge_chunks_for_account",
  );
});

Deno.test("a Vercel embedding uses the admin-saved key when AI_GATEWAY_API_KEY is unset", async () => {
  const realFetch = globalThis.fetch;
  const prior = Deno.env.get("AI_GATEWAY_API_KEY");
  Deno.env.delete("AI_GATEWAY_API_KEY");
  let authorization: string | null = null;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }));
  }) as typeof fetch;
  try {
    const vectors = await embedWithVercel(["hello"], { ...stubbedConfig, provider: "vercel" }, (code) =>
      Promise.resolve(code === "vercel" ? "db-key" : null));
    assertEquals(vectors, [[0.1, 0.2]]);
    assertEquals(authorization, "Bearer db-key");
  } finally {
    globalThis.fetch = realFetch;
    if (prior !== undefined) Deno.env.set("AI_GATEWAY_API_KEY", prior);
  }
});

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>) {
  const prior = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    await run();
  } finally {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  }
}

function captureAuthorization(): { restore: () => void; seen: () => string | null; body: () => Record<string, unknown> } {
  const realFetch = globalThis.fetch;
  let authorization: string | null = null;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    sent = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }));
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = realFetch; }, seen: () => authorization, body: () => sent };
}

Deno.test("a Jina embedding uses the admin-saved key when JINA_API_KEY is unset", async () => {
  await withEnv("JINA_API_KEY", undefined, async () => {
    const capture = captureAuthorization();
    try {
      const vectors = await embedKnowledge(["hello"], stubbedConfig, "query", (code) =>
        Promise.resolve(code === "jina" ? "db-jina" : null));
      assertEquals(vectors, [[0.1, 0.2]]);
      assertEquals(capture.seen(), "Bearer db-jina");
      assertEquals(capture.body().task, "retrieval.query");
    } finally {
      capture.restore();
    }
  });
});

Deno.test("an unreadable key table falls back to the provider's env var", async () => {
  await withEnv("OPENROUTER_API_KEY", "env-or", async () => {
    const key = await embeddingProviderKey("openrouter", "OPENROUTER_API_KEY", () => Promise.reject(new Error("read failed")));
    assertEquals(key, "env-or");
  });
});

Deno.test("a missing key fails naming the env var and sends no request", async () => {
  await withEnv("GOOGLE_AI_STUDIO_KEY", undefined, async () => {
    const capture = captureAuthorization();
    try {
      await assertRejects(
        () => embedKnowledge(["hello"], { ...stubbedConfig, provider: "gemini" }, "passage", () => Promise.resolve(null)),
        Error,
        "GOOGLE_AI_STUDIO_KEY is not configured",
      );
      assertEquals(capture.seen(), null);
    } finally {
      capture.restore();
    }
  });
});
