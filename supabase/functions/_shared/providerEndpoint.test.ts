// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { clearProviderEndpointCache, loadOpenAiCompatibleBase, type RowReader } from "./providerEndpoint.ts";

const adminReturning = (row: unknown, calls: string[] = []): RowReader => ({
  from: (t: string) => {
    calls.push(t);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) };
  },
});

Deno.test("returns the trimmed base for an active openai-type provider and caches it", async () => {
  clearProviderEndpointCache();
  const calls: string[] = [];
  const admin = adminReturning({ api_endpoint: "https://ai-gateway.vercel.sh/v1/", api_type: "openai", is_active: true }, calls);
  assertEquals(await loadOpenAiCompatibleBase(admin, "vercel"), "https://ai-gateway.vercel.sh/v1");
  assertEquals(await loadOpenAiCompatibleBase(admin, "vercel"), "https://ai-gateway.vercel.sh/v1");
  assertEquals(calls.length, 1);
});

Deno.test("a cached endpoint is re-read once it is older than 60 seconds", async () => {
  clearProviderEndpointCache();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const calls: string[] = [];
    const admin = adminReturning({ api_endpoint: "https://x/v1", api_type: "openai", is_active: true }, calls);
    await loadOpenAiCompatibleBase(admin, "ttl");
    now += 59_999;
    await loadOpenAiCompatibleBase(admin, "ttl");
    assertEquals(calls.length, 1);
    now += 1;
    await loadOpenAiCompatibleBase(admin, "ttl");
    assertEquals(calls.length, 2);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("returns null for inactive, non-openai or missing providers", async () => {
  clearProviderEndpointCache();
  assertEquals(await loadOpenAiCompatibleBase(adminReturning({ api_endpoint: "x", api_type: "openai", is_active: false }), "a"), null);
  assertEquals(await loadOpenAiCompatibleBase(adminReturning({ api_endpoint: "x", api_type: "anthropic", is_active: true }), "b"), null);
  assertEquals(await loadOpenAiCompatibleBase(adminReturning(null), "c"), null);
});
