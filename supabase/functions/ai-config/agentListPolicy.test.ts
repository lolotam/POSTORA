import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildAgentListPolicy, validateAgentTier } from "./agentListPolicy.ts";
import type { ChatPolicySnapshot } from "./chatListPolicy.ts";
import { composeAiTiers } from "../_shared/ai-user-routing.ts";
import { hasLaterAgentApiTier } from "../_shared/agentRecovery.ts";

const auth = { provider_code: "claude", model_id: "same", auth_method: "oauth" };
const api = { provider_code: "openai", model_id: "tool-model" };
const request = { category: "agent", slot: "primary", ...auth, expected: { default_ai_model_agent: api, default_ai_model_agent_fallback: api } };
function source(): ChatPolicySnapshot {
  return {
    flags: { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_category_text_ladders: false, feature_ai_oauth_tools_claude: true, feature_ai_oauth_tools_codex: true },
    providers: ["claude", "openai"].map(provider_code => ({ id: provider_code, provider_code, name: provider_code, is_active: true })),
    models: [{ provider_id: "openai", model_id: "tool-model", name: "API tools", capabilities: ["chat", "tools"], is_active: true },
      { provider_id: "openai", model_id: "chat-only", name: "Chat only", capabilities: ["chat"], is_active: true }],
    apiKeys: { openai: true }, settings: [], statuses: [{ provider_code: "claude", status: "connected" }], registry: { claude: ["same"], openai: ["codex"] }, toolRegistry: { claude: ["same"] },
  };
}
Deno.test("Agent groups require Claude tool flag and verified tool capability; Codex stays refused", () => {
  const snapshot = source();
  let groups = buildAgentListPolicy(snapshot).groups;
  assertEquals(groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.reason, null);
  assertEquals(groups.find(g => g.provider_code === "openai" && g.auth_method === "oauth")?.reason, "oauth_tools_unsupported");
  assertEquals(groups.find(g => g.provider_code === "openai" && g.auth_method === "api_key")?.models.find(m => m.model_id === "chat-only")?.reason, "tools_unsupported");
  snapshot.flags.feature_ai_oauth_tools_claude = false;
  groups = buildAgentListPolicy(snapshot).groups;
  assertEquals(groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.reason, "oauth_tools_disabled");
});

for (const [active, master, tools, status, reason] of [
  [false, false, false, "disconnected", "inactive"],
  [true, false, false, "reauth_required", "flag_off"],
  [true, true, false, "reauth_required", "oauth_tools_disabled"],
  [true, true, true, "reauth_required", "reauth_required"],
  [true, true, true, "connected", null],
] as const) Deno.test(`Agent availability precedence ${reason ?? "ready"}`, () => {
  const snapshot = source();
  snapshot.providers[0].is_active = active;
  snapshot.flags.feature_ai_provider_oauth = master;
  snapshot.flags.feature_ai_oauth_tools_claude = tools;
  snapshot.statuses[0].status = status;
  assertEquals(buildAgentListPolicy(snapshot).groups.find(g => g.provider_code === "claude" && g.auth_method === "oauth")?.reason, reason);
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
