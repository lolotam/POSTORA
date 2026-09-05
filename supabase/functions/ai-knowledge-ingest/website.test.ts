import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildWebsiteSourceName } from "./index.ts";

Deno.test("a page source is named by host and path", () => {
  assertEquals(
    buildWebsiteSourceName("https://xsellpoint.com/shop/shoes", "page"),
    "xsellpoint.com/shop/shoes",
  );
});

Deno.test("a page source at the root drops the bare slash", () => {
  assertEquals(buildWebsiteSourceName("https://xsellpoint.com/", "page"), "xsellpoint.com");
});

Deno.test("a site source is named by host and says so", () => {
  assertEquals(
    buildWebsiteSourceName("https://xsellpoint.com/shop", "site"),
    "xsellpoint.com (whole site)",
  );
});

Deno.test("a long path is truncated so the name stays readable in the list", () => {
  const name = buildWebsiteSourceName(`https://x.com/${"a".repeat(300)}`, "page");
  assertEquals(name.length <= 120, true);
  assertEquals(name.endsWith("…"), true);
});

Deno.test("an unparseable URL still yields a name rather than throwing", () => {
  // The caller validates first, so this cannot normally happen -- but a naming
  // helper that can throw would turn a cosmetic problem into a failed ingest.
  assertEquals(buildWebsiteSourceName("not a url", "page").length > 0, true);
});
