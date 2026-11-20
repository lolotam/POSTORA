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

Deno.test("a permanent Google refresh refusal asks for a reconnect, not a retry", () => {
  // invalid_client / unauthorized_client land here: retrying can never succeed,
  // so the answer is reconnect_required, not upstream_unavailable (502 "try again").
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "failed", reason: "refresh_refused" }),
    { ok: false, code: "reconnect_required" },
  );
  assertEquals(
    tokenResultFromOutcome({
      ...failure,
      ok: false,
      status: "retryable_refusal",
      retryable: false,
      reason: "refresh_refused",
    }),
    { ok: false, code: "reconnect_required" },
  );
});

Deno.test("a vanished account row and a held lease stay upstream_unavailable", () => {
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "failed", reason: "account_not_found" }),
    { ok: false, code: "upstream_unavailable" },
  );
  assertEquals(
    tokenResultFromOutcome({
      ...failure,
      ok: false,
      status: "retryable_refusal",
      retryable: true,
      reason: "lease_hold",
    }),
    { ok: false, code: "upstream_unavailable" },
  );
});

Deno.test("a lease held elsewhere or a transient failure is upstream_unavailable", () => {
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "retryable_refusal", retryable: true, reason: "refresh_in_progress" }),
    { ok: false, code: "upstream_unavailable" },
  );
});
