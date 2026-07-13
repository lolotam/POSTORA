import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { chunkRows } from "./chunking.ts";

Deno.test("chunkRows splits an oversized spreadsheet row without losing content", () => {
  const text = "x".repeat(2_401);

  const chunks = chunkRows([{ text, sheet: "Products", row: 2 }]);

  assertEquals(chunks.every((chunk) => chunk.content.length <= 1_200), true);
  assertEquals(chunks.map((chunk) => chunk.content).join(""), text);
  assertEquals(chunks.map((chunk) => chunk.metadata.row_range), ["2-2", "2-2", "2-2"]);
});
