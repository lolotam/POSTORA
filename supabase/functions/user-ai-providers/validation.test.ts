import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyResponse,
  PROVIDERS,
  validateKey,
  validationRequest,
} from "./validation.ts";

Deno.test("validation uses authenticated fixed provider endpoints, including OpenRouter introspection", async () => {
  const expected = [
    "https://api.openai.com/v1/models",
    "https://api.anthropic.com/v1/models",
    "https://generativelanguage.googleapis.com/v1beta/models?key=secret%26test",
    "https://openrouter.ai/api/v1/key",
  ];
  for (const [index, provider] of PROVIDERS.entries()) {
    const fetcher: typeof fetch = (input, init) => {
      assert(input instanceof Request);
      assertEquals(input.url, expected[index]);
      assertEquals(input.method, "GET");
      assertEquals(input.redirect, "error");
      assert(init?.signal instanceof AbortSignal);
      if (provider === "claude") {
        assertEquals(input.headers.get("x-api-key"), "secret&test");
        assertEquals(input.headers.get("anthropic-version"), "2023-06-01");
      } else if (provider !== "gemini") {
        assertEquals(input.headers.get("Authorization"), "Bearer secret&test");
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    assertEquals(await validateKey(provider, "secret&test", fetcher), "valid");
  }
});

Deno.test("provider status classification separates invalid credentials from transient outages", () => {
  for (const status of [200, 204, 299]) {
    assertEquals(classifyResponse(status), "valid");
  }
  for (const status of [400, 401, 404, 422]) {
    assertEquals(classifyResponse(status), "invalid");
  }
  // A key scoped away from the probe endpoint is authenticated, hence usable.
  assertEquals(classifyResponse(403), "valid");
  for (const status of [429, 500, 503]) {
    assertEquals(classifyResponse(status), "transient");
  }
  assertEquals(
    validationRequest("openrouter", "key").url.endsWith("/api/v1/key"),
    true,
  );
});

Deno.test("network failure and aborted fetch are transient without exposing exception text", async () => {
  for (
    const error of [
      new Error("sensitive URL"),
      new DOMException("timeout", "AbortError"),
    ]
  ) {
    const fetcher: typeof fetch = () => Promise.reject(error);
    assertEquals(await validateKey("gemini", "secret", fetcher), "transient");
  }
});
