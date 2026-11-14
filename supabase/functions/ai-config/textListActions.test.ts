import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateTextMutation } from "./textListActions.ts";
import type { ChatPolicySnapshot } from "./chatListPolicy.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadChatPolicySnapshot } from "./chatListActions.ts";
const tier = (provider_code: string, model_id = "same") => ({ provider_code, model_id, auth_method: "oauth" });
function snapshot(): ChatPolicySnapshot {
  return { flags: { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_category_text_ladders: true,
    feature_ai_oauth_tools_claude: false, feature_ai_oauth_tools_codex: false },
    providers: ["claude", "openai"].map(id => ({ id, provider_code: id, name: id, is_active: true })), models: [], settings: [],
    statuses: ["claude", "openai"].map(provider_code => ({ provider_code, status: "connected" })), apiKeys: {}, registry: { claude: ["same"], openai: ["same"] } };
}

for (const credential of ['unrelated_google', 'saved_gemini', 'environment', 'absent'] as const) {
  Deno.test(`text floor readiness uses runtime credentials: ${credential}`, async () => {
    const previous = Deno.env.get('GOOGLE_AI_STUDIO_KEY');
    Deno.env.delete('GOOGLE_AI_STUDIO_KEY');
    if (credential === 'environment') Deno.env.set('GOOGLE_AI_STUDIO_KEY', crypto.randomUUID());
    const google = { id: 'google', provider_code: 'google', name: 'Google', is_active: true };
    const admin = createClient('https://fixture.invalid', crypto.randomUUID(), { global: { fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/ai_providers')) return Response.json(url.searchParams.has('order') ? [google] : { api_key_env_var: null });
      if (url.pathname.endsWith('/provider_api_keys')) {
        const provider = url.searchParams.get('provider_code');
        const present = credential === 'unrelated_google' ? provider === 'eq.google' : credential === 'saved_gemini' && provider === 'eq.gemini';
        return Response.json(present ? { api_key: crypto.randomUUID() } : null);
      }
      return Response.json([]);
    } } });
    try {
      const source = await loadChatPolicySnapshot(admin, snapshot().flags, AbortSignal.timeout(1000));
      assertEquals(source.textFloorAvailable, credential === 'saved_gemini' || credential === 'environment');
      const request = { category: 'caption', slot: 'primary', ...tier('openai'), expected: {}, expected_chat: {} };
      const effectiveSource = { ...snapshot(), providers: [...snapshot().providers, google], textFloorAvailable: source.textFloorAvailable };
      if (source.textFloorAvailable) assertEquals(validateTextMutation(request, effectiveSource, 'set-text-tier').category, 'caption');
      else assertThrows(() => validateTextMutation(request, effectiveSource, 'set-text-tier'), Error, 'ai_output_cap_unsupported');
    } finally {
      if (previous === undefined) Deno.env.delete('GOOGLE_AI_STUDIO_KEY'); else Deno.env.set('GOOGLE_AI_STUDIO_KEY', previous);
    }
  });
}
for (const category of ["caption", "hashtags"] as const) {
  Deno.test(`${category} decodes string siblings without changing raw CAS or extensions`, () => {
    const sibling = { ...tier("claude"), extension: { retain: true } };
    const expected = { [`default_ai_model_${category}`]: JSON.stringify(sibling) };
    const saved = validateTextMutation({ category, slot: "fallback", ...tier("claude"), expected, expected_chat: {} }, snapshot(), "set-text-tier");
    assertEquals(saved.chain[`default_ai_model_${category}`], sibling);
    assertEquals(saved.expected, expected);
  });
  Deno.test(`${category} inherits legacy Chat with absent primary and string fallback`, () => {
    const expected_chat = { default_ai_model_chat_fallback: JSON.stringify(tier("claude")) };
    assertEquals(validateTextMutation({ category, expected: {}, expected_chat }, snapshot(), "inherit-text-category").chain, {});
  });
  Deno.test(`${category} cannot use an unrelated saved google key as its floor`, () => {
    const source = snapshot();
    source.providers.push({ id: "google", provider_code: "google", name: "Google", is_active: true });
    source.apiKeys.google = true;
    assertThrows(() => validateTextMutation({ category, slot: "primary", ...tier("openai"), expected: {}, expected_chat: {} }, source, "set-text-tier"), Error, "ai_output_cap_unsupported");
  });
  Deno.test(`${category} inheritance never adds a floor displaced by a configured third tier`, () => {
    const source = snapshot();
    source.textFloorAvailable = true;
    source.providers.push({ id: "google", provider_code: "google", name: "Google", is_active: true });
    assertThrows(() => validateTextMutation({ category, expected: {}, expected_chat: {
      default_ai_model_chat: tier("openai"), default_ai_model_chat_fallback_2: JSON.stringify(tier("openai")),
    } }, source, "inherit-text-category"), Error, "ai_output_cap_unsupported");
  });
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
