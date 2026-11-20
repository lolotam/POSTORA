import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenResultFromOutcome } from "./tokens.ts";

const failure = { retryable: false, accessToken: null, expiresAt: null, needsReauth: false };

Deno.test("a stored fresh token is usable and not marked as minted", () => {
  const accessToken = crypto.randomUUID();
  assertEquals(
    tokenResultFromOutcome({ ok: true, status: "fresh", accessToken, expiresAt: null, grantedScopes: null }),
    { ok: true, accessToken, minted: false },
  );
});

Deno.test("a token another worker just committed is not marked as minted", () => {
  const accessToken = crypto.randomUUID();
  assertEquals(
    tokenResultFromOutcome({ ok: true, status: "reused", accessToken, expiresAt: null, grantedScopes: null }),
    { ok: true, accessToken, minted: false },
  );
});

Deno.test("a token this call refreshed is marked as minted", () => {
  const accessToken = crypto.randomUUID();
  assertEquals(
    tokenResultFromOutcome({ ok: true, status: "refreshed", accessToken, expiresAt: null, grantedScopes: null }),
    { ok: true, accessToken, minted: true },
  );
});

Deno.test("needs_reauth and a missing refresh token both ask for a reconnect", () => {
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "needs_reauth", reason: "needs_reauth", needsReauth: true }),
    { ok: false, code: "reconnect_required" },
  );
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "failed", reason: "no_refresh_token" }),
    { ok: false, code: "reconnect_required" },
  );
});

Deno.test("a lease held elsewhere or a transient failure is upstream_unavailable", () => {
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "retryable_refusal", retryable: true, reason: "refresh_in_progress" }),
    { ok: false, code: "upstream_unavailable" },
  );
});
