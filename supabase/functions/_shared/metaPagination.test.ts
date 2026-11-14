import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { metaNextCursor } from "./metaPagination.ts";

Deno.test("Graph alias resolution preserves the requested edge and follows only the cursor", () => {
  for (const edge of ["accounts", "permissions"]) {
    const body = (path: string) => ({ paging: { next: `https://graph.facebook.com${path}?access_token=ignored`, cursors: { after: "page_2" } } });
    const path = `/v22.0/me/${edge}`;
    assertEquals(metaNextCursor(body(`/v22.0/300001/${edge}`), "https://graph.facebook.com", path, new Set()), "page_2");
    for (const invalid of [`/v25.0/300001/${edge}`, "/v22.0/300001/feed", `/v22.0/foreign/${edge}`]) {
      assertThrows(() => metaNextCursor(body(invalid), "https://graph.facebook.com", path, new Set()));
    }
  }
});
