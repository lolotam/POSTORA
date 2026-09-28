import { assertEquals } from "jsr:@std/assert@1";
import { sanitizeMediaFilename } from "./mediaFilename.ts";

Deno.test("frontend and edge filename sanitisers are the same file text", async () => {
  const edge = await Deno.readTextFile(new URL("./mediaFilename.ts", import.meta.url));
  const browser = await Deno.readTextFile(new URL("../../../src/lib/mediaFilename.ts", import.meta.url));
  assertEquals(edge, browser);
});

Deno.test("a name over 240 characters keeps the extension and the DB CHECK bound", () => {
  const long = "x".repeat(300) + ".pdf";
  assertEquals(sanitizeMediaFilename(long), "x".repeat(236) + ".pdf");
  assertEquals([...sanitizeMediaFilename(long)].length, 240);
  const arabic = "\u062a".repeat(300) + ".pdf";
  assertEquals([...sanitizeMediaFilename(arabic)].length, 240);
  assertEquals(sanitizeMediaFilename(arabic).endsWith(".pdf"), true);
});

Deno.test("hostile names are stripped: control characters, bidi, dots and encoded separators", () => {
  assertEquals(sanitizeMediaFilename("in\u0007voi\u0000ce.pdf"), "invoice.pdf");
  assertEquals(sanitizeMediaFilename("\u202Einvoice\u202C.pdf"), "invoice.pdf");
  assertEquals(sanitizeMediaFilename("\u2066x\u2069.pdf"), "x.pdf");
  assertEquals(sanitizeMediaFilename(".."), "file");
  assertEquals(sanitizeMediaFilename("."), "file");
  assertEquals(sanitizeMediaFilename("   "), "file");
  assertEquals(sanitizeMediaFilename(""), "file");
  // An encoded separator decodes to a slash and is basename-stripped again.
  assertEquals(sanitizeMediaFilename("a%2Fb.txt"), "b.txt");
  assertEquals(sanitizeMediaFilename("a%2fb.txt"), "b.txt");
  assertEquals(sanitizeMediaFilename("..\\evil.txt"), "evil.txt");
});

Deno.test("a URL falls back to its decoded last path segment without query or fragment", () => {
  assertEquals(sanitizeMediaFilename("https://cdn.example/a/postora_2026_ab12.pdf?token=1#x"), "postora_2026_ab12.pdf");
  assertEquals(sanitizeMediaFilename("https://cdn.example/a/report%20final.pdf"), "report final.pdf");
  assertEquals(sanitizeMediaFilename("https://cdn.example/"), "file");
});
