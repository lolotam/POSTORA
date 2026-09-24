// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { clearProviderEndpointCache, loadOpenAiCompatibleBase } from "./providerEndpoint.ts";

const adminReturning = (row: any, calls: string[] = []) => ({
  from: (t: string) => {
    calls.push(t);
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
    return q;
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

Deno.test("returns null for inactive, non-openai or missing providers", async () => {
  clearProviderEndpointCache();
  assertEquals(await loadOpenAiCompatibleBase(adminReturning({ api_endpoint: "x", api_type: "openai", is_active: false }), "a"), null);
  assertEquals(await loadOpenAiCompatibleBase(adminReturning({ api_endpoint: "x", api_type: "anthropic", is_active: true }), "b"), null);
  assertEquals(await loadOpenAiCompatibleBase(adminReturning(null), "c"), null);
});
