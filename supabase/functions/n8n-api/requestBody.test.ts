// handleRequest cannot be driven in-process without env and a database (see
// the tripwire note in rateLimitEnforcement.test.ts), so these tests prove
// each piece of the path — the parse failure, the typed error, the 400
// response and its rate-limit headers — plus a source tripwire on the live
// router.
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { InvalidRequestBodyError, looksLikeJson, readJsonBody } from "./requestBody.ts";
import { handleRequest, invalidRequestBodyResponse } from "./index.ts";

for (const { route, body } of [
  { route: "/api/v1/comments/reply", body: '{"comment_id":' },
  { route: "/api/v1/post", body: '{"caption":"hi","platforms":["facebook"' },
]) {
  Deno.test(`a truncated JSON body to ${route} is an InvalidRequestBodyError, not a crash`, async () => {
    const request = new Request(`https://x.test/n8n-api${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await assertRejects(
      () => readJsonBody(request),
      InvalidRequestBodyError,
      "The request body is not valid JSON.",
    );
  });
}

Deno.test("readJsonBody returns the parsed body for valid JSON", async () => {
  const request = new Request("https://x.test/n8n-api/api/v1/post", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"caption":"hi","platforms":["facebook"]}',
  });

  assertEquals(await readJsonBody(request), {
    caption: "hi",
    platforms: ["facebook"],
  });
});

Deno.test("looksLikeJson tells a JSON body apart from a form body", () => {
  assertEquals(looksLikeJson('  {"a":'), true);
  assertEquals(looksLikeJson("[1"), true);
  assertEquals(looksLikeJson("caption=hi&platforms=facebook"), false);
});

Deno.test("invalidRequestBodyResponse answers 400 INVALID_REQUEST with the rate limit headers", async () => {
  const req = new Request("https://x.test/n8n-api/api/v1/post", { method: "POST" });

  const response = invalidRequestBodyResponse(
    req,
    { remaining: 41, resetAt: new Date("2030-01-01T00:00:00Z") },
    { requests: 60, windowMs: 3600000, enforced: true, source: "global_setting" },
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    success: false,
    error: {
      code: "INVALID_REQUEST",
      message: "The request body is not valid JSON.",
    },
  });
  assertEquals(response.headers.get("X-RateLimit-Limit"), "60");
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "41");
  assertEquals(response.headers.get("X-RateLimit-Reset"), "2030-01-01T00:00:00.000Z");
  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("tripwire: the router answers an invalid body before the generic error path", () => {
  const routerSource = handleRequest.toString();
  assertEquals(routerSource.includes("instanceof InvalidRequestBodyError"), true);
  assertEquals(routerSource.includes("invalidRequestBodyResponse("), true);
  assertEquals(
    routerSource.indexOf("instanceof InvalidRequestBodyError") <
      routerSource.indexOf("getSafeErrorResponse("),
    true,
  );
});

Deno.test("tripwire: the router never reads a request body with .json()", () => {
  // A bare .json() throws on a malformed body and lands in the generic catch,
  // which is exactly the failure this module exists to remove.
  const routerSource = handleRequest.toString();
  assertEquals(routerSource.includes("req.json()"), false);
  assertEquals(routerSource.includes("request.json()"), false);
});
