// Opt-in LIVE smoke test: proves the pinned npm:@mariozechner/pi-ai@0.73.1 import
// loads under Deno and completes one real request. NOT run in CI or in the
// regular suite. Run explicitly with:
//
//   PI_LIVE=1 OPENAI_API_KEY=sk-... deno test --no-config \
//     --node-modules-dir=none --allow-env --allow-net \
//     supabase/functions/_shared/aiOAuth/piCall.live.test.ts
//
// Spends a few tokens of the provided key.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const LIVE_ENABLED = Deno.env.get("PI_LIVE") === "1";

Deno.test({
  name: "live: pi-ai loads in Deno and answers a chat completion",
  ignore: !LIVE_ENABLED,
  async fn() {
    const { defaultPiCallDeps } = await import("./piCall.ts");
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    assert(apiKey !== undefined, "OPENAI_API_KEY must be set when PI_LIVE=1");

    const deps = defaultPiCallDeps();
    const model = deps.getModel("openai", "gpt-4o-mini");
    assert(model !== undefined, "pi-ai getModel must resolve gpt-4o-mini");

    const assistant = await deps.complete(
      model,
      { messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }] },
      { apiKey, signal: AbortSignal.timeout(30_000), maxTokens: 16 },
    );
    assertEquals(assistant.stopReason, "stop");
    assert(assistant.content.some((part) => part.type === "text"));
  },
});
