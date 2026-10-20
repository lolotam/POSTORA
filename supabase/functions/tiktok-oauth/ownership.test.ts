import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// Service-role calls carry the body user_id and bypass RLS, so the user_id filter is the only
// ownership check. A filter applied only to user-JWT callers lets a service-role request with
// user A's id act on user B's account.
//
// This is a source-level guard: the queries are inline in the Deno.serve handler, so a
// behavioural test would mean standing up the whole TikTok flow.

Deno.test("ownership filters are never skipped for service-role callers", () => {
  assertEquals((source.match(/isServiceRole/g) ?? []).length, 0);
});

Deno.test("every social_accounts query by account_id is scoped to the caller", () => {
  // Comments are stripped first: a semicolon inside one would end a chain early and hide it.
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  const chains = code.match(/\.from\("social_accounts"\)[^;]*\.eq\("id", account_id\)[^;]*;/g) ?? [];
  // creator_info read, refresh read and refresh update at least.
  assertEquals(chains.length >= 3, true, `expected at least 3 queries by account_id, found ${chains.length}`);
  for (const chain of chains) {
    assertEquals(chain.includes('.eq("user_id", caller.userId)'), true, `unscoped query: ${chain}`);
  }
});
