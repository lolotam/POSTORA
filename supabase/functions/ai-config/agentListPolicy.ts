import { z } from "npm:zod@3.23.8";
import { normalizeStoredTextTier } from "../_shared/textTierValue.ts";
import { hasLaterAgentApiTier, supportsAgentApiTools } from "../_shared/agentRecovery.ts";
import { buildChatListPolicy, ChatTierError, type ChatListGroup, type ChatPolicySnapshot } from "./chatListPolicy.ts";

export const AGENT_TIER_KEYS = ["default_ai_model_agent", "default_ai_model_agent_fallback", "default_ai_model_agent_fallback_2"] as const;
export function buildAgentListPolicy(source: ChatPolicySnapshot): { groups: ChatListGroup[] } {
  const groups = buildChatListPolicy(source).groups;
  for (const group of groups) {
    const provider = source.providers.find(p => p.provider_code === group.provider_code);
    for (const model of group.models) {
      const row = source.models.find(m => m.provider_id === provider?.id && m.model_id === model.model_id && (m.auth_method ?? "api_key") === group.auth_method);
      if (!model.reason && !(group.auth_method === "oauth" ? source.toolRegistry?.[group.provider_code]?.includes(model.model_id) : row && supportsAgentApiTools(row))) model.reason = "tools_unsupported";
    }
    if (group.auth_method === "oauth") {
      // One precedence: inactive, master, transport/flag, connection, model.
      if (group.reason !== "inactive" && group.reason !== "flag_off") {
        if (group.provider_code !== "claude") group.reason = "oauth_tools_unsupported";
        else if (!source.flags.feature_ai_oauth_tools_claude) group.reason = "oauth_tools_disabled";
      }
    }
    if (group.reason === "no_compatible_models") group.reason = "no_compatible_agent_models";
    if (!group.reason && !group.models.some(m => !m.reason)) group.reason = "no_compatible_agent_models";
  }
  return { groups };
}
const requestSchema = z.object({ category: z.literal("agent"), slot: z.enum(["primary", "fallback", "fallback_2"]),
  provider_code: z.string().min(1).max(120), model_id: z.string().min(1).max(300), auth_method: z.enum(["api_key", "oauth"]).optional(), expected: z.record(z.unknown()),
}).strict();
export function validateAgentTier(body: unknown, source: ChatPolicySnapshot) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw new ChatTierError("invalid_agent_tier", 400);
  if (!source.flags.feature_ai_text_auth_lists) throw new ChatTierError("text_lists_disabled");
  const request = parsed.data;
  if (Object.keys(request.expected).some(key => !AGENT_TIER_KEYS.some(k => key === k))) throw new ChatTierError("invalid_agent_chain", 400);
  const groups = buildAgentListPolicy(source).groups;
  const eligible = (tier: { provider_code: string; model_id: string; auth_method?: string }) => {
    const group = groups.find(g => g.provider_code === tier.provider_code && g.auth_method === (tier.auth_method ?? "api_key"));
    return Boolean(group && !group.reason && group.models.some(m => m.model_id === tier.model_id && !m.reason));
  };
  if (!eligible(request)) throw new ChatTierError("agent_model_tools_unavailable");
  const key = AGENT_TIER_KEYS[["primary", "fallback", "fallback_2"].indexOf(request.slot)];
  const value = { provider_code: request.provider_code, model_id: request.model_id, ...(request.auth_method === "oauth" ? { auth_method: "oauth" } : {}) };
  const next = { ...request.expected, [key]: value };
  const chain = [];
  let gap = false;
  try {
    for (const key of AGENT_TIER_KEYS) {
      const tier = normalizeStoredTextTier(next[key]);
      if (!tier) { gap = true; continue; }
      if (gap) throw new Error();
      chain.push({ ...tier, credentialSource: "platform", authMethod: tier.auth_method });
    }
  } catch { throw new ChatTierError("invalid_agent_chain"); }
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].authMethod === "oauth" && !hasLaterAgentApiTier(chain, i, eligible)) throw new ChatTierError("oauth_api_fallback_required");
  }
  return { key, value, expected: request.expected };
}
