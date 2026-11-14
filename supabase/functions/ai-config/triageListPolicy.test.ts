import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildTriageListPolicy, validateTriageTier } from "./chatListPolicy.ts";
import type { ChatPolicySnapshot } from "./chatListPolicy.ts";

function snapshot(): ChatPolicySnapshot {
  return {
    flags: { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_category_text_ladders: false,
      feature_ai_oauth_tools_claude: false, feature_ai_oauth_tools_codex: false },
    providers: ["claude", "openai", "openrouter", "deepseek"].map(provider_code => ({ id: provider_code, provider_code, name: provider_code, is_active: true })),
    models: [
      { provider_id: "openrouter", model_id: "typesafe/jev-1.13", name: "Jev", is_active: true, capabilities: ["triage"] },
      { provider_id: "deepseek", model_id: "fast", name: "Fast", is_active: true, capabilities: ["triage_chat"] },
      { provider_id: "openai", model_id: "ordinary", name: "Ordinary Chat", is_active: true, capabilities: ["chat"] },
      { provider_id: "claude", model_id: "same", name: "Claude API", is_active: true, capabilities: ["chat", "triage_chat"] },
    ],
    settings: [], statuses: [{ provider_code: "claude", status: "connected" }, { provider_code: "openai", status: "connected" }],
    apiKeys: { openrouter: true, deepseek: true, claude: true, openai: true }, registry: { claude: ["same"], openai: ["codex"] },
  };
}
const request = { category: "agent_triage", slot: "primary", provider_code: "claude", model_id: "same", auth_method: "oauth", expected: {} };

Deno.test("Triage policy preserves Jev and approved fast API models, permits parsed Claude and disables capped Codex", () => {
  const policy = buildTriageListPolicy(snapshot());
  const group = (provider: string, auth: string) => policy.groups.find(g => g.provider_code === provider && g.auth_method === auth)!;
  assertEquals(group("openrouter", "api_key").models.map(m => m.model_id), ["typesafe/jev-1.13"]);
  assertEquals(group("deepseek", "api_key").reason, null);
  assertEquals(group("openai", "api_key").models, []);
  assertEquals(group("claude", "api_key").reason, "triage_api_unsupported");
  assertEquals(group("claude", "oauth").reason, null);
  assertEquals(group("claude", "oauth").models[0].provisional, true);
  assertEquals(group("openai", "oauth").reason, "oauth_max_tokens_unsupported");
});

Deno.test("Triage save accepts Claude-only Auth and Jev API; rejects Codex-only and unusable capped ladders", () => {
  const source = snapshot();
  assertEquals(validateTriageTier(request, source).value, { provider_code: "claude", model_id: "same", auth_method: "oauth" });
  assertEquals(validateTriageTier({ ...request, provider_code: "openrouter", model_id: "typesafe/jev-1.13", auth_method: "api_key" }, source).value,
    { provider_code: "openrouter", model_id: "typesafe/jev-1.13" });
  for (const change of [
    { provider_code: "openai", model_id: "codex" }, { auth_method: "unknown" }, { auth_method: "api_key" },
    { slot: "fallback" }, { slot: "fallback_2" }, { category: "agent" },
  ]) assertThrows(() => validateTriageTier({ ...request, ...change }, source));
});

Deno.test("Triage whole-chain expectations retain raw JSON strings and sibling extension fields", () => {
  const expected = { default_ai_model_agent_triage: JSON.stringify({ provider_code: "claude", model_id: "same", auth_method: "oauth", extension: { kept: true } }) };
  const tier = validateTriageTier({ ...request, slot: "fallback", provider_code: "deepseek", model_id: "fast", auth_method: "api_key", expected }, snapshot());
  assertEquals(tier.expected, expected);
  assertEquals(tier.key, "default_ai_model_agent_triage_fallback");
  assertThrows(() => validateTriageTier({ ...request, expected: { unrelated: null } }, snapshot()));
});

for (const reason of ["flag_off", "reauth_required", "inactive", "disconnected", "not_connected"] as const) {
  Deno.test(`Triage readiness retains unavailable Claude: ${reason}`, () => {
    const source = snapshot();
    if (reason === "flag_off") source.flags.feature_ai_provider_oauth = false;
    else if (reason === "inactive") source.providers[0].is_active = false;
    else source.statuses[0].status = reason;
    assertEquals(buildTriageListPolicy(source).groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.reason, reason);
    assertThrows(() => validateTriageTier(request, source));
  });
}

Deno.test("Triage respects persisted OAuth deactivation and successful empty sync", () => {
  const source = snapshot();
  source.models.push({ provider_id: "claude", model_id: "same", name: "Claude Auth", auth_method: "oauth", is_active: false, capabilities: ["chat"] });
  assertEquals(buildTriageListPolicy(source).groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.models[0].reason, "inactive");
  source.models = source.models.filter(m => m.auth_method !== "oauth");
  source.settings.push({ key: "model_catalog_synced_at_claude_oauth", value: { at: "2026-11-14T00:00:00Z" } });
  assertThrows(() => validateTriageTier(request, source));
  source.flags.feature_ai_text_auth_lists = false;
  assertThrows(() => validateTriageTier(request, source));
});
