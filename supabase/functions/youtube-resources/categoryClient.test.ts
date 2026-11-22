import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createYouTubeCategoryClient,
  parseVideoCategoriesResponse,
} from "./categoryClient.ts";

const responseBody = {
  items: [
    { id: "30", snippet: { title: "Movies", assignable: false, localized: { ar: { title: "الأفلام" } } } },
    { id: "22", snippet: { title: "People & Blogs", assignable: true, localized: { ar: { title: "الأشخاص والمدونات" } } } },
  ],
};

Deno.test("a provider response is validated, localized and sorted by numeric id", () => {
  const english = parseVideoCategoriesResponse(responseBody, "en")!;
  assertEquals(english.map((option) => [option.id, option.assignable]), [["22", true], ["30", false]]);
  assertEquals(english[0].label, "\u206822\u2069 (People & Blogs)");
  const arabic = parseVideoCategoriesResponse(responseBody, "ar")!;
  assertEquals(arabic[0].name, "الأشخاص والمدونات");
  assertEquals(parseVideoCategoriesResponse({ items: [{ id: "not-a-number", snippet: {} }] }, "en"), null);
});

Deno.test("the adapter sends a read-only provider request with no token in logs or body", async () => {
  let requested = "";
  let authorization = "";
  const client = createYouTubeCategoryClient({
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input);
      authorization = String((init?.headers as Record<string, string>).Authorization);
      return Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 }));
    }) as typeof fetch,
  });
  const result = await client.list("fixture-token", { region: "sa", locale: "ar-EG" });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.region, "SA");
  assertEquals(result.locale, "ar");
  assertEquals(result.value.length, 2);
  const url = new URL(requested);
  assertEquals(url.origin + url.pathname, "https://www.googleapis.com/youtube/v3/videoCategories");
  assertEquals(url.searchParams.get("part"), "snippet");
  assertEquals(url.searchParams.get("regionCode"), "SA");
  assertEquals(url.searchParams.get("hl"), "ar");
  assertEquals(authorization, "Bearer fixture-token");
});

Deno.test("provider failures are typed with a bounded quota retry", async () => {
  const client = createYouTubeCategoryClient({
    fetchImpl: (() => Promise.resolve(new Response("{}", {
      status: 429,
      headers: { "retry-after": "120" },
    }))) as typeof fetch,
  });
  assertEquals(await client.list("token", { region: "US", locale: "en" }), {
    ok: false, code: "quota_exceeded", retryAfterSeconds: 120,
  });
});
