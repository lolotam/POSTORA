import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "npm:xlsx@0.18.5";
import { parseSourceFile } from "./parsing.ts";

// parseSourceFile is now shared by the inline ingest path and the queue worker.
// Before this it lived inside ai-knowledge-ingest, so the worker understood
// workbooks only -- which is why a large markdown or PDF had no queue to fall
// back to and was killed by the 60s edge ceiling instead.

const blob = (text: string) => new Blob([text]);

Deno.test("a markdown document becomes chunks", async () => {
  const chunks = await parseSourceFile(
    "doc",
    "guide.md",
    blob("# Prices\n\nStarter plan is 10 KWD.\nGrowth plan is 20 KWD.\n"),
  );
  assertEquals(chunks.length > 0, true);
  assertEquals(chunks.some((chunk) => chunk.content.includes("10 KWD")), true);
});

Deno.test("an empty document is refused rather than indexed as nothing", async () => {
  // A source with zero chunks is retrievable by nothing; failing loudly is the
  // only outcome that tells the user why their file does not answer questions.
  await assertRejects(() => parseSourceFile("doc", "empty.md", blob("   \n\n ")));
});

Deno.test("a workbook still parses exactly as it did before the extraction", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([{ Product: "Starter plan", Price: "10 KWD" }]),
    "Products",
  );
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });

  const chunks = await parseSourceFile("excel", "prices.xlsx", new Blob([bytes]));

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].metadata, { sheet: "Products", row_range: "2-2" });
  assertEquals(chunks[0].content.includes("Product: Starter plan"), true);
});

Deno.test("an unknown source type is refused by name", async () => {
  // The queue claim lists the types it will hand over; if the two ever drift,
  // this is the error that says so instead of a silent mis-parse.
  await assertRejects(
    () => parseSourceFile("video", "clip.mp4", blob("x")),
    Error,
    "Source type not supported: video",
  );
});
