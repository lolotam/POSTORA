import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildChatListPolicy, validateChatTier, type ChatPolicySnapshot } from "./chatListPolicy.ts";

function snapshot(): ChatPolicySnapshot {
  return {
    flags: { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true,
      feature_ai_category_text_ladders: false, feature_ai_oauth_tools_claude: false, feature_ai_oauth_tools_codex: false },
    providers: [{ id: "p", provider_code: "claude", name: "Claude", is_active: true }],
    models: [{ provider_id: "p", model_id: "same", name: "API same", auth_method: "api_key", is_active: true, capabilities: ["chat"] }],
    settings: [], statuses: [{ provider_code: "claude", status: "connected" }],
    apiKeys: { claude: true }, registry: { claude: ["same", "registry-only"], openai: ["codex"] },
  };
}

Deno.test("a retry retains the browser expectation even after the server snapshot changes", async () => {
  const source = snapshot();
  source.settings = [{ key: "default_ai_model_chat", value: { provider_code: "claude", model_id: "registry-only", auth_method: "oauth" } }];
  const request = { category: "chat", slot: "primary", provider_code: "claude", model_id: "same" };
  assertEquals(validateChatTier({ ...request, expected: {} }, source).expected, {});
  await assertRejects(async () => validateChatTier(request, source), "Missing browser expectation must not become a fresh server expectation");
});

Deno.test("Chat keeps API/Auth identity and provisional entries before first OAuth sync", () => {
  const policy = buildChatListPolicy(snapshot());
  const api = policy.groups.find(g => g.provider_code === "claude" && g.auth_method === "api_key")!;
  const auth = policy.groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")!;
  assertEquals(api.models[0].model_id, auth.models[0].model_id);
  assertEquals(auth.models[0].provisional, true);
  assertEquals(policy.groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")?.reason, "not_connected");
});

for (const state of ["flag_off", "inactive", "reauth_required", "disconnected", "api_key_absent", "no_compatible_models"] as const) {
  Deno.test(`Chat availability: ${state}`, () => {
    const source = snapshot();
    if (state === "flag_off") source.flags.feature_ai_provider_oauth = false;
    if (state === "inactive") source.providers[0].is_active = false;
    if (state === "reauth_required" || state === "disconnected") source.statuses[0].status = state;
    if (state === "api_key_absent") source.apiKeys.claude = false;
    if (state === "no_compatible_models") source.registry.claude = [];
    const group = buildChatListPolicy(source).groups.find(g => g.provider_code === "claude" && g.auth_method === (state === "api_key_absent" ? "api_key" : "oauth"))!;
    assertEquals(group.reason, state);
  });
}

Deno.test("successful OAuth sync and inactive rows prevent registry resurrection", () => {
  const source = snapshot();
  source.models.push({ provider_id: "p", model_id: "same", name: "Auth same", auth_method: "oauth", is_active: false, capabilities: ["chat"] });
  let auth = buildChatListPolicy(source).groups.find(g => g.auth_method === "oauth" && g.provider_code === "claude")!;
  assertEquals(auth.models.map(m => m.model_id), ["same"]);
  assertEquals(auth.models[0].reason, "inactive");
  source.models = source.models.filter(m => m.auth_method !== "oauth");
  source.settings.push({ key: "model_catalog_synced_at_claude_oauth", value: { at: "2026-11-14T00:00:00Z" } });
  auth = buildChatListPolicy(source).groups.find(g => g.auth_method === "oauth" && g.provider_code === "claude")!;
  assertEquals(auth.models, []);
  assertEquals(auth.reason, "no_compatible_models");
});

Deno.test("Chat mutation validates auth, selected eligibility and contiguous chain without changing API shape", async () => {
  const source = snapshot();
  assertEquals(validateChatTier({ expected: {}, category: "chat", slot: "primary", provider_code: "claude", model_id: "same" }, source).value,
    { provider_code: "claude", model_id: "same" });
  assertEquals(validateChatTier({ expected: {}, category: "chat", slot: "primary", provider_code: "claude", model_id: "same", auth_method: "oauth" }, source).value,
    { provider_code: "claude", model_id: "same", auth_method: "oauth" });
  for (const invalid of [
    { auth_method: "unknown" }, { model_id: "" }, { model_id: "unlisted" },
    { slot: "fallback" }, { slot: "fallback_2" }, { category: "agent" },
  ]) await assertRejects(async () => validateChatTier({ expected: {}, category: "chat", slot: "primary", provider_code: "claude", model_id: "same", ...invalid }, source));
  source.apiKeys.claude = false;
  await assertRejects(async () => validateChatTier({ expected: {}, category: "chat", slot: "primary", provider_code: "claude", model_id: "same" }, source));
});

Deno.test("persisted Auth rows must also be supported by the runtime registry", async () => {
  const source = snapshot();
  source.models.push({ provider_id: "p", model_id: "not-in-registry", name: "Unverified", auth_method: "oauth", is_active: true, capabilities: ["chat"] });
  const auth = buildChatListPolicy(source).groups.find(g => g.auth_method === "oauth" && g.provider_code === "claude")!;
  assertEquals(auth.models[0].reason, "unsupported_model");
  await assertRejects(async () => validateChatTier({ expected: {}, category: "chat", slot: "primary", provider_code: "claude", model_id: "not-in-registry", auth_method: "oauth" }, source));
});

Deno.test("stored sibling tiers with extension fields stay valid while the requested tier stays strict", () => {
  const source = snapshot();
  const sibling = { provider_code: "claude", model_id: "same", provider_option: "kept-by-other-writer" };
  const expected = { default_ai_model_chat: sibling };
  const result = validateChatTier({ expected, category: "chat", slot: "fallback", provider_code: "claude", model_id: "same" }, source);
  assertEquals(result.expected, expected);
  assertEquals(result.key, "default_ai_model_chat_fallback");
});
