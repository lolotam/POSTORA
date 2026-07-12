import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as XLSX from "npm:xlsx@0.18.5";
import { parseExcelChunks } from "./index.ts";

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
