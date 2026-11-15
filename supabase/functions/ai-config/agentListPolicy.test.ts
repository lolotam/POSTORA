import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildAgentListPolicy, validateAgentTier } from "./agentListPolicy.ts";
import type { ChatPolicySnapshot } from "./chatListPolicy.ts";
import { composeAiTiers } from "../_shared/ai-user-routing.ts";
import { hasLaterAgentApiTier } from "../_shared/agentRecovery.ts";
import { mapOpenRouterCatalog } from "../_shared/modelCatalogSync.ts";

Deno.test("synced capability keeps an existing API selection usable and qualifies the only recovery tier", () => {
  const snapshot = source();
  snapshot.providers.push({ id: "openrouter", provider_code: "openrouter", name: "Router", is_active: true });
  snapshot.apiKeys.openrouter = true;
  const mapped = mapOpenRouterCatalog([{ id: "chosen", supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } }]);
  snapshot.models = [...snapshot.models.filter(m => m.model_id === "chat-only"), ...mapped.models.map(m => ({ ...m, provider_id: "openrouter", auth_method: "api_key", is_active: true }))];
  const chosen = { provider_code: "openrouter", model_id: "chosen" };
  snapshot.flags.feature_ai_oauth_tools_claude = false;
  assertEquals(validateAgentTier({ category: "agent", slot: "primary", ...chosen, expected: { default_ai_model_agent: chosen } }, snapshot).value, chosen);
  snapshot.flags.feature_ai_oauth_tools_claude = true;
  assertEquals(validateAgentTier({ ...request, expected: { default_ai_model_agent: auth, default_ai_model_agent_fallback: chosen } }, snapshot).value, auth);
});

const auth = { provider_code: "claude", model_id: "same", auth_method: "oauth" };
const api = { provider_code: "openai", model_id: "tool-model" };
const request = { category: "agent", slot: "primary", ...auth, expected: { default_ai_model_agent: api, default_ai_model_agent_fallback: api } };
function source(): ChatPolicySnapshot {
  return {
    flags: { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_category_text_ladders: false, feature_ai_oauth_tools_claude: true, feature_ai_oauth_tools_codex: true },
    providers: ["claude", "openai"].map(provider_code => ({ id: provider_code, provider_code, name: provider_code, is_active: true })),
    models: [{ provider_id: "openai", model_id: "tool-model", name: "API tools", capabilities: ["chat", "tools"], is_active: true },
      { provider_id: "openai", model_id: "chat-only", name: "Chat only", capabilities: ["chat"], is_active: true }],
    apiKeys: { openai: true }, settings: [], statuses: ["claude", "openai"].map(provider_code => ({ provider_code, status: "connected" })), registry: { claude: ["same"], openai: ["codex"] }, toolRegistry: { claude: ["same"], openai: ["codex"] },
  };
}
Deno.test("Agent groups require independent provider tool flags and verified tool capability", () => {
  const snapshot = source();
  let groups = buildAgentListPolicy(snapshot).groups;
  assertEquals(groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.reason, null);
  assertEquals(groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")?.reason, null);
  assertEquals(groups.find(g => g.provider_code === "openai" && g.auth_method === "api_key")?.models.find(m => m.model_id === "chat-only")?.reason, "tools_unsupported");
  snapshot.flags.feature_ai_oauth_tools_claude = false;
  groups = buildAgentListPolicy(snapshot).groups;
  assertEquals(groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.reason, "oauth_tools_disabled");
  assertEquals(groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")?.reason, null);
  snapshot.flags.feature_ai_oauth_tools_codex = false;
  assertEquals(buildAgentListPolicy(snapshot).groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")?.reason, "oauth_tools_disabled");
});

for (const [active, master, tools, status, reason] of [
  [false, false, false, "disconnected", "inactive"],
  [true, false, false, "reauth_required", "flag_off"],
  [true, true, false, "reauth_required", "oauth_tools_disabled"],
  [true, true, true, "reauth_required", "reauth_required"],
  [true, true, true, "connected", null],
] as const) for (const provider of ["claude", "openai"] as const) Deno.test(`Agent ${provider} availability precedence ${reason ?? "ready"}`, () => {
  const snapshot = source();
  snapshot.providers.find(row => row.provider_code === provider)!.is_active = active;
  snapshot.flags.feature_ai_provider_oauth = master;
  snapshot.flags[provider === "claude" ? "feature_ai_oauth_tools_claude" : "feature_ai_oauth_tools_codex"] = tools;
  snapshot.statuses.find(row => row.provider_code === provider)!.status = status;
  assertEquals(buildAgentListPolicy(snapshot).groups.find(g => g.provider_code === provider && g.auth_method === "oauth")?.reason, reason);
});

Deno.test("Codex Agent save still requires a later chosen tool-capable API tier", () => {
  const codex = { provider_code: "openai", model_id: "codex", auth_method: "oauth" };
  assertEquals(validateAgentTier({ ...request, ...codex }, source()).value, codex);
  assertThrows(() => validateAgentTier({ ...request, ...codex, expected: { default_ai_model_agent: codex } }, source()));
  const snapshot = source();
  snapshot.toolRegistry!.openai = [];
  assertEquals(buildAgentListPolicy(snapshot).groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")?.models[0].reason, "tools_unsupported");
});

for (const metadata of [null, { tool_calling: true }, { tool_calling: false }]) Deno.test(`Codex Agent catalogue capability precedence ${JSON.stringify(metadata)}`, () => {
  const snapshot = source();
  snapshot.models.push({ provider_id: "openai", model_id: "codex", name: "Codex", auth_method: "oauth", capabilities: ["chat"], is_active: true, metadata });
  const group = buildAgentListPolicy(snapshot).groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")!;
  assertEquals(group.models[0].reason, metadata?.tool_calling === false ? "tools_unsupported" : null);
});

for (const [name, change, accepted] of [
  ["later chosen active API", {}, true],
  ["all Auth", { expected: { default_ai_model_agent: auth, default_ai_model_agent_fallback: auth } }, false],
  ["Auth last", { slot: "fallback", expected: { default_ai_model_agent: api } }, false],
  ["no primary", { slot: "fallback", expected: {} }, false],
  ["capability not established", { expected: { default_ai_model_agent: api, default_ai_model_agent_fallback: { ...api, model_id: "chat-only" } } }, false],
  ["unknown auth discriminator", { auth_method: "magic" }, false],
] as const) Deno.test(`Agent save: ${name}`, () => {
  if (accepted) assertEquals(validateAgentTier({ ...request, ...change }, source()).value, auth);
  else assertThrows(() => validateAgentTier({ ...request, ...change }, source()));
});

Deno.test("Agent effective-chain validation follows routing consent and the three-tier cap", () => {
  const user = { provider: "openai", model: "user", credentialSource: "user" as const, apiKey: crypto.randomUUID() };
  const platform = [{ provider: "claude", model: "a", authMethod: "oauth" as const, credentialSource: "platform" as const },
    { provider: "claude", model: "b", authMethod: "oauth" as const, credentialSource: "platform" as const },
    { provider: "openai", model: "tool-model", credentialSource: "platform" as const }];
  for (const mode of ["postora_only", "user_first", "user_only"] as const) {
    const chain = composeAiTiers({ mode, allowPlatformFallback: mode === "user_first", userTier: mode === "postora_only" ? undefined : user }, platform);
    assertEquals(chain.length, mode === "user_only" ? 1 : 3);
    assertEquals(hasLaterAgentApiTier(chain, mode === "postora_only" ? 0 : 1, () => true), mode === "postora_only");
  }
});
