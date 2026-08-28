import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as XLSX from "npm:xlsx@0.18.5";
import { parseCsvChunks, parseExcelChunks, processSource, type WorkerDependencies } from "./index.ts";
import { resolveDualEmbeddingConfigFromDb } from "../_shared/knowledgeEmbeddings.ts";

Deno.test("parseExcelChunks converts workbook rows into knowledge chunks", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { Product: "Starter plan", Price: "10 KWD" },
      { Product: "Growth plan", Price: "20 KWD" },
    ]),
    "Products",
  );
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });

  const chunks = parseExcelChunks(bytes);

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].metadata, { sheet: "Products", row_range: "2-3" });
  assertEquals(chunks[0].content.includes("Product: Starter plan"), true);
  assertEquals(chunks[0].content.includes("Price: 20 KWD"), true);
});

Deno.test("parseCsvChunks produces the same chunk shape as the Excel path", () => {
  const rows = [
    { Product: "Starter plan", Price: "10 KWD" },
    { Product: "Growth plan", Price: "20 KWD" },
  ];
  const workbook = XLSX.utils.book_new();
  // SheetJS names a parsed CSV's only sheet "Sheet1", so match it here to make
  // the metadata directly comparable.
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Sheet1");
  const excelBytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const csvBytes = new TextEncoder().encode(
    "Product,Price\nStarter plan,10 KWD\nGrowth plan,20 KWD\n",
  );

  assertEquals(parseCsvChunks(csvBytes.buffer), parseExcelChunks(excelBytes));
});

// ---------------------------------------------------------------------------
// Resumable processing (asserts on rows written and calls made)
// ---------------------------------------------------------------------------

type ChunkRow = { id: string; metadata: Record<string, unknown> | null };

function workerHarness(csv: string, existingChunks: ChunkRow[]) {
  const state = {
    chunkInserts: Array<Array<Record<string, unknown>>>(),
    deletedAllOfSource: [] as string[],
    deletedIds: [] as string[],
    sourceUpdates: [] as Array<Record<string, unknown>>,
    settingUpserts: [] as Array<Record<string, unknown>>,
  };
  const admin = {
    storage: {
      from: () => ({
        download: () => Promise.resolve({ data: new Blob([csv]) }),
      }),
    },
    from: (table: string) => {
      if (table === "system_settings") {
        return {
          select: () => ({ in: () => Promise.resolve({ data: [] }) }),
          upsert: (row: Record<string, unknown>) => {
            state.settingUpserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "ai_knowledge_chunks") {
        return {
          select: () => ({
            eq: (_col: string, value: string) => {
              assertEquals(_col, "source_id");
              assertEquals(value, "source-1");
              return Promise.resolve({ data: existingChunks });
            },
          }),
          delete: () => ({
            eq: (col: string, value: string) => {
              if (col === "source_id") state.deletedAllOfSource.push(value);
              return Promise.resolve({ error: null });
            },
            in: (col: string, ids: string[]) => {
              assertEquals(col, "id");
              state.deletedIds.push(...ids);
              return Promise.resolve({ error: null });
            },
          }),
          insert: (rows: Array<Record<string, unknown>>) => {
            state.chunkInserts.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, value: string) => {
            assertEquals(col, "id");
            assertEquals(value, "source-1");
            state.sourceUpdates.push(patch);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
  return { admin, state };
}

/** Ten ~2k-char rows: each exceeds half a chunk budget, so 1 row = 1 chunk = 10 chunks = batches of 8+2. */
const longRow = (label: string) => `${label},${"x".repeat(2_000)}`;
const tenRowCsv = `Name,Filler\n${Array.from({ length: 10 }, (_, i) => longRow(`row-${i}`)).join("\n")}\n`;

const source = (overrides: Record<string, unknown> = {}) => ({
  id: "source-1",
  user_id: "user-1",
  file_name: "catalog.csv",
  file_path: "supabase://ai-knowledge/user-1/sources/catalog.csv",
  source_type: "csv",
  chunk_count: 0,
  ...overrides,
});

function dependencies(clock: { now: () => number }, embedError?: Error) {
  const embedCalls: string[][] = [];
  const deps: WorkerDependencies = {
    embed: async (texts: string[]) => {
      if (embedError) throw embedError;
      embedCalls.push(texts);
      return { primary: texts.map(() => Array.from({ length: 1024 }, () => 0.1)), fallback: null };
    },
    resolveConfig: (admin) => resolveDualEmbeddingConfigFromDb(admin, () => undefined),
    now: clock.now,
  };
  return { deps, embedCalls };
}

Deno.test("a fresh source deletes everything, stamps chunk_index, and checkpoints per batch", async () => {
  const { admin, state } = workerHarness(tenRowCsv, [
    { id: "stale", metadata: { sheet: "Sheet1" } },
  ]);
  const { deps, embedCalls } = dependencies({ now: () => 0 });

  const outcome = await processSource(admin, source(), deps);

  assertEquals(outcome.status, "ready");
  assertEquals(outcome.chunkCount, 10);
  assertEquals(state.deletedAllOfSource, ["source-1"]);
  assertEquals(state.deletedIds, []);
  assertEquals(embedCalls.length, 2);
  assertEquals(embedCalls[0].length, 8);
  assertEquals(state.chunkInserts.length, 2);
  assertEquals(
    state.chunkInserts[0].map((row) => (row.metadata as Record<string, unknown>).chunk_index),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assertEquals(
    state.chunkInserts[1].map((row) => (row.metadata as Record<string, unknown>).chunk_index),
    [8, 9],
  );
  assertEquals(
    state.sourceUpdates.map((patch) => patch.chunk_count),
    [8, 10, 10],
  );
  assertEquals(state.sourceUpdates.at(-1), { status: "ready", chunk_count: 10, error: null });
  // The first successful batch claims the vector columns for its models.
  assertEquals(state.settingUpserts.length > 0, true);
});

Deno.test("a resumed source deletes only chunks at or past the checkpoint and re-embeds the remainder", async () => {
  const { admin, state } = workerHarness(tenRowCsv, [
    { id: "c6", metadata: { sheet: "Sheet1", row_range: "7-7", chunk_index: 6 } },
    { id: "c7", metadata: { sheet: "Sheet1", row_range: "8-8", chunk_index: 7 } },
    { id: "c8", metadata: { sheet: "Sheet1", row_range: "9-9", chunk_index: 8 } },
    { id: "c9", metadata: { sheet: "Sheet1", row_range: "10-10", chunk_index: 9 } },
    { id: "legacy", metadata: { sheet: "Sheet1" } },
  ]);
  const { deps, embedCalls } = dependencies({ now: () => 0 });

  const outcome = await processSource(admin, source({ chunk_count: 8 }), deps);

  assertEquals(outcome.status, "ready");
  assertEquals(outcome.resumed, true);
  // The 0..7 prefix is untouched: only the crash window (8, 9) and the
  // unindexed legacy row are deleted.
  assertEquals(state.deletedIds, ["c8", "c9", "legacy"]);
  assertEquals(state.deletedAllOfSource, []);
  assertEquals(embedCalls.length, 1);
  assertEquals(embedCalls[0].length, 2);
  assertEquals(
    state.chunkInserts[0].map((row) => (row.metadata as Record<string, unknown>).chunk_index),
    [8, 9],
  );
  assertEquals(state.sourceUpdates.map((patch) => patch.chunk_count), [10, 10]);
  assertEquals(state.sourceUpdates.at(-1), { status: "ready", chunk_count: 10, error: null });
});

Deno.test("hitting the time budget leaves the source processing with an accurate checkpoint", async () => {
  const { admin, state } = workerHarness(tenRowCsv, []);
  // The clock reads 0 when batch 1 starts and is past the deadline from the
  // second read on, so batch 2 never begins.
  let reads = 0;
  const now = () => (reads++ === 0 ? 0 : 1_000);
  const { deps, embedCalls } = dependencies({ now });

  const outcome = await processSource(admin, source(), deps, 100);

  assertEquals(outcome.status, "processing");
  assertEquals(outcome.chunkCount, 8);
  assertEquals(embedCalls.length, 1);

  const resumed = await processSource(admin, source({ chunk_count: 8 }), deps, 100);
  assertEquals(resumed.status, "processing", "deadline already exceeded, nothing more runs");
  assertEquals(resumed.chunkCount, 8);
  assertEquals(embedCalls.length, 1, "no further embedding happens past the budget");
  assertEquals(state.sourceUpdates.map((patch) => patch.chunk_count), [8]);
  assertEquals(
    state.sourceUpdates.some((patch) => patch.status === "ready"),
    false,
  );
});

Deno.test("a processing error marks the source failed with the sanitized message", async () => {
  const { admin, state } = workerHarness(tenRowCsv, []);
  const { deps } = dependencies({ now: () => 0 }, new Error("ollama unreachable"));

  const outcome = await processSource(admin, source(), deps);

  assertEquals(outcome.status, "failed");
  assertEquals(outcome.reason, "ollama unreachable");
  assertEquals(state.sourceUpdates.at(-1)?.status, "failed");
  assertEquals(state.sourceUpdates.at(-1)?.error, "ollama unreachable");
});


// file_path is owner-writable through RLS while the worker holds the service
// role, so a source pointed at another user's object must be refused before any
// byte is read — otherwise it is chunked into the pointing user's knowledge base
// and answered from by their agent.
Deno.test("a source pointed outside its owner's folder is refused, not downloaded", async () => {
  const { admin, state } = workerHarness(tenRowCsv, []);
  const { deps, embedCalls } = dependencies({ now: () => 0 });

  const outcome = await processSource(
    admin,
    source({ file_path: "supabase://ai-knowledge/user-2/sources/secret.csv" }),
    deps,
  );

  assertEquals(outcome.status, "failed");
  assertEquals(outcome.reason, "Knowledge file location is not allowed");
  assertEquals(embedCalls.length, 0);
  assertEquals(state.chunkInserts.length, 0);
});
