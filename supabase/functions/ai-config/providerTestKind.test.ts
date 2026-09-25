// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { providerTestKind } from "./providerTestKind.ts";

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
