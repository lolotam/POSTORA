import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// Every write that stores a freshly-authorized token must also clear the health flags.
// Otherwise a completed reconnect leaves the row showing "Action Required: Reconnect" —
// PostgREST upserts only update the columns present in the payload, so stale
// needs_reauth / failure_count / last_refresh_error values survive verbatim.
//
// This is a source-level guard: the payloads are inline object literals inside the
// OAuth handler, so a behavioural test would mean standing up the whole Facebook flow.

Deno.test("every social_accounts upsert clears needs_reauth", () => {
  const upserts = (source.match(/\.upsert\(/g) ?? []).length;
  const cleared = (source.match(/needs_reauth:\s*false/g) ?? []).length;
  assertEquals(
    cleared,
    upserts,
    `${upserts} upsert(s) but only ${cleared} needs_reauth:false — a reconnect path leaves the flag set`,
  );
});

Deno.test("failure tracking is reset alongside needs_reauth", () => {
  const cleared = (source.match(/needs_reauth:\s*false/g) ?? []).length;
  assertEquals((source.match(/failure_count:\s*0/g) ?? []).length, cleared);
  assertEquals((source.match(/last_refresh_error:\s*null/g) ?? []).length, cleared);
});
