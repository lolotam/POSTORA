import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isPermanentMetaError, parseMetaError } from "./metaErrors.ts";

Deno.test("OAuthException code 190 is a permanent auth failure", () => {
  assertEquals(
    isPermanentMetaError({ type: "OAuthException", code: 190, transient: false }),
    true,
  );
});

Deno.test("each documented permanent subcode escalates", () => {
  for (const sub of [458, 460, 463, 467]) {
    assertEquals(
      isPermanentMetaError({ type: "OAuthException", code: 200, error_subcode: sub, transient: false }),
      true,
      `subcode ${sub} should be permanent`,
    );
  }
});

Deno.test("an unrelated ID containing 190 is NOT permanent", () => {
  // The regression guard for the substring trap: PERMANENT_AUTH_ERRORS matches
  // substrings, so a numeric code in that list would match this message and latch
  // a healthy account to needs_reauth forever.
  assertEquals(
    isPermanentMetaError({
      type: "OAuthException",
      code: 100,
      message: "(#100) Object with ID '1190345' does not exist",
      transient: false,
    }),
    false,
  );
});

Deno.test("a transient failure is never permanent, whatever its code", () => {
  assertEquals(isPermanentMetaError({ type: "OAuthException", code: 190, transient: true }), false);
});

Deno.test("parseMetaError extracts the sanitized fields and marks 5xx transient", () => {
  const permanent = parseMetaError(400, {
    error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
  });
  assertEquals(permanent.type, "OAuthException");
  assertEquals(permanent.code, 190);
  assertEquals(permanent.error_subcode, 463);
  assertEquals(permanent.transient, false);

  assertEquals(parseMetaError(503, { error: { message: "upstream" } }).transient, true);
});

Deno.test("a rate limit is transient, so three of them cannot latch an account", () => {
  // 429 is not >= 500. Without explicit handling this reads as a hard failure and, after
  // three, crosses the ceiling and retires a healthy account.
  for (const code of [4, 17, 32, 613]) {
    assertEquals(
      parseMetaError(429, { error: { type: "OAuthException", code, message: "rate limited" } }).transient,
      true,
      `code ${code} is a rate limit and must be transient`,
    );
  }
});

Deno.test("structured permanent evidence outranks a 5xx status", () => {
  // A revoked grant reported alongside a server error must not be retried forever.
  assertEquals(
    parseMetaError(500, {
      error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
    }).transient,
    false,
  );
});

Deno.test("parseMetaError survives a body with no error object", () => {
  const e = parseMetaError(200, { nonsense: true });
  assertEquals(e.transient, false);
  assertEquals(e.code, undefined);
});
