import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { chunkRows } from "./chunking.ts";

Deno.test("chunkRows splits oversized spreadsheet rows into 3000-character chunks", () => {
  const text = "x".repeat(6_001);

  const chunks = chunkRows([{ text, sheet: "Products", row: 2 }]);

  assertEquals(chunks.every((chunk) => chunk.content.length <= 3_000), true);
  assertEquals(chunks.map((chunk) => chunk.content).join(""), text);
  assertEquals(chunks.map((chunk) => chunk.metadata.row_range), ["2-2", "2-2", "2-2"]);
});
