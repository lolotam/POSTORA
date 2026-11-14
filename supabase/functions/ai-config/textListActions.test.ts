import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateTextMutation } from "./textListActions.ts";
import type { ChatPolicySnapshot } from "./chatListPolicy.ts";
const tier = (provider_code: string, model_id = "same") => ({ provider_code, model_id, auth_method: "oauth" });
function snapshot(): ChatPolicySnapshot {
  return { flags: { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_category_text_ladders: true,
    feature_ai_oauth_tools_claude: false, feature_ai_oauth_tools_codex: false },
    providers: ["claude", "openai"].map(id => ({ id, provider_code: id, name: id, is_active: true })), models: [], settings: [],
    statuses: ["claude", "openai"].map(provider_code => ({ provider_code, status: "connected" })), apiKeys: {}, registry: { claude: ["same"], openai: ["same"] } };
}
for (const category of ["caption", "hashtags"] as const) {
  Deno.test(`${category} saves Claude-only Auth and preserves sibling extensions`, () => {
    const expected = { [`default_ai_model_${category}`]: { ...tier("claude"), extension: { retain: true } } };
    const saved = validateTextMutation({ category, slot: "fallback", ...tier("claude"), expected, expected_chat: {} }, snapshot(), "set-text-tier");
    assertEquals(saved.chain[`default_ai_model_${category}`], expected[`default_ai_model_${category}`]);
    assertEquals(saved.chain[`default_ai_model_${category}_fallback`], tier("claude"));
  });
  Deno.test(`${category} rejects a capped Codex-only chain and Codex-only inheritance`, () => {
    const request = { category, slot: "primary", ...tier("openai"), expected: {}, expected_chat: {} };
    assertThrows(() => validateTextMutation(request, snapshot(), "set-text-tier"), Error, "ai_output_cap_unsupported");
    assertThrows(() => validateTextMutation({ category, expected: {}, expected_chat: { default_ai_model_chat: tier("openai") } }, snapshot(), "inherit-text-category"), Error, "ai_output_cap_unsupported");
  });
  Deno.test(`${category} primary, contiguous slots, strict auth, and both flags enforced`, () => {
    const request = { category, slot: "primary", ...tier("claude"), expected: {}, expected_chat: {} };
    for (const patch of [{ slot: "fallback" }, { auth_method: "unknown" }, { expected: { [`default_ai_model_${category}_fallback_2`]: tier("claude") } }])
      assertThrows(() => validateTextMutation({ ...request, ...patch }, snapshot(), "set-text-tier"));
    for (const flag of ["feature_ai_text_auth_lists", "feature_ai_category_text_ladders"] as const) {
      const source = snapshot(); source.flags[flag] = false;
      assertThrows(() => validateTextMutation(request, source, "set-text-tier"), Error, "text_lists_disabled");
    }
  });
  Deno.test(`${category} reset removes the entire chain without seeding Chat choices`, () => {
    const expected = { [`default_ai_model_${category}`]: tier("claude"), [`default_ai_model_${category}_fallback`]: tier("claude") };
    const reset = validateTextMutation({ category, expected, expected_chat: { default_ai_model_chat: tier("claude") } }, snapshot(), "inherit-text-category");
    assertEquals(reset.chain, {}); assertEquals(reset.expected, expected);
  });
}
