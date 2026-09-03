import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyComposioError,
  classifyGoogleError,
} from "./youtubeApiErrors.ts";

const google = (reason: string, code = 403) => ({
  error: { code, message: "x", errors: [{ reason, domain: "youtube" }] },
});

const cases: Array<[number, unknown, string]> = [
  [403, google("insufficientPermissions"), "scope_missing"],
  [403, google("quotaExceeded"), "quota"],
  [403, google("dailyLimitExceeded"), "quota"],
  [429, google("rateLimitExceeded", 429), "quota"],
  [401, google("authError", 401), "unauthorized"],
  [404, google("commentNotFound", 404), "not_found"],
  [403, google("forbidden"), "forbidden"],
  [500, {}, "upstream"],
  [200, null, "upstream"],
];

for (const [status, body, expected] of cases) {
  Deno.test(
    `classifyGoogleError ${status} ${
      JSON.stringify(body)?.slice(0, 40)
    } -> ${expected}`,
    () => assertEquals(classifyGoogleError(status, body), expected),
  );
}

Deno.test("classifyComposioError reads the Google reason out of Composio's message", () => {
  assertEquals(
    classifyComposioError(
      'Request had insufficient authentication scopes. {"reason":"insufficientPermissions"}',
    ),
    "scope_missing",
  );
  assertEquals(
    classifyComposioError(
      "The request cannot be completed because you have exceeded your quota.",
    ),
    "quota",
  );
  assertEquals(
    classifyComposioError("401 Unauthorized: invalid_grant"),
    "unauthorized",
  );
  assertEquals(classifyComposioError(undefined), "upstream");
});
