// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ProviderTestError } from "./providerErrors.ts";
import { probeProvider, providerTestKind } from "./aiProviderTest.ts";

const kind = (provider_code: string, api_type = "openai") => providerTestKind({ provider_code, api_type });

// Regression 2026-09-25: the card Test sent Firecrawl and ElevenLabs keys to /chat/completions.
Deno.test("non-chat services get their own probe instead of a chat completion", () => {
  assertEquals(kind("firecrawl", "rest"), "firecrawl");
  assertEquals(kind("apify", "rest"), "apify");
  assertEquals(kind("elevenlabs", "elevenlabs"), "elevenlabs");
  assertEquals(kind("my-voice", "elevenlabs"), "elevenlabs");
  assertEquals(kind("brave_search"), "brave");
  assertEquals(kind("exa"), "exa");
  assertEquals(kind("jina"), "jina");
});

Deno.test("vendors with a models-list probe are routed by code", () => {
  assertEquals(kind("zai"), "zai");
  assertEquals(kind("xai"), "xai");
  assertEquals(kind("minimax"), "minimax");
  assertEquals(kind("perplexity"), "perplexity");
});

Deno.test("api_type decides the rest, defaulting to an OpenAI-compatible chat call", () => {
  assertEquals(kind("gemini", "google"), "google");
  assertEquals(kind("claude", "anthropic"), "anthropic");
  assertEquals(kind("vercel"), "openai");
  assertEquals(kind("deepseek"), "openai");
});

Deno.test("the probe kind still follows the provider code first", () => {
  assertEquals(providerTestKind({ provider_code: "xai", api_type: "openai" }), "xai");
  assertEquals(providerTestKind({ provider_code: "custom", api_type: "anthropic" }), "anthropic");
  assertEquals(providerTestKind({ provider_code: "custom", api_type: null }), "openai");
});

const XAI_TARGET = { id: "1", provider_code: "xai", api_type: "openai", api_endpoint: "https://api.x.ai/v1" };

Deno.test("a provider that never answers fails with a timeout, not a hang", async () => {
  const slowFetch = (_url: string, _init?: RequestInit) =>
    new Promise<Response>((_resolve) => { /* never settles */ });
  await assertRejects(
    () => probeProvider({}, XAI_TARGET, "sk-test", 50, slowFetch as unknown as typeof fetch),
    ProviderTestError,
  );
});

Deno.test("a provider error carries the status and never the key", async () => {
  const unauthorizedFetch = (async () =>
    new Response('{"error":{"message":"Incorrect API key provided: sk-secret"}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const err = await assertRejects(
    () => probeProvider({}, XAI_TARGET, "sk-secret", 1000, unauthorizedFetch),
    ProviderTestError,
  ) as unknown as ProviderTestError;
  assertEquals(err.status, 401);
  assert(!err.message.includes("sk-secret"));
});

Deno.test("a probe that answers resolves without throwing", async () => {
  const okFetch = (async () =>
    new Response('{"data":[{"id":"grok-4"}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await probeProvider({}, XAI_TARGET, "sk-test", 1000, okFetch);
});
