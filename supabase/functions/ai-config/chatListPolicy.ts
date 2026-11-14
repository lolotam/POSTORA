import { z } from "npm:zod@3.23.8";
import type { AiTextFlags } from "../_shared/aiOAuth/textFlags.ts";
import { normalizeStoredTextTier } from "../_shared/textTierValue.ts";
import { supportsOutputCap } from "../_shared/textLadders.ts";

export type ChatListReason = "flag_off" | "inactive" | "not_connected" | "reauth_required" | "disconnected" | "api_key_absent" | "no_compatible_models" | "no_compatible_triage_models" | "oauth_max_tokens_unsupported" | "triage_api_unsupported";
export interface ChatListModel { model_id: string; name: string; provisional: boolean; reason: "inactive" | "unsupported_model" | null }
export interface ChatListGroup {
  provider_code: string; auth_method: "api_key" | "oauth"; name: string;
  reason: ChatListReason | null; synced_at: string | null; models: ChatListModel[];
}
export interface ChatPolicySnapshot {
  flags: AiTextFlags;
  providers: Array<{ id: string; provider_code: string; name: string; is_active: boolean }>;
  models: Array<{ provider_id: string; model_id: string; name: string; auth_method?: string; is_active: boolean; capabilities: string[] }>;
  settings: Array<{ key: string; value: unknown }>;
  statuses: Array<{ provider_code: string; status: string }>;
  apiKeys: Record<string, boolean>;
  /** Read through the runtime credential resolver; never inferred from another provider's key. */
  textFloorAvailable?: boolean;
  registry: Record<string, string[]>;
}

const AUTH_NAMES: Record<string, string> = { claude: "Claude subscription", openai: "OpenAI Codex subscription", openrouter: "OpenRouter Auth" };

function catalogueFor(source: ChatPolicySnapshot, providerCode: string, authMethod: "api_key" | "oauth", category: "chat" | "agent_triage") {
  const provider = source.providers.find(p => p.provider_code === providerCode);
  const rows = source.models.filter(m => m.provider_id === provider?.id && (m.auth_method ?? "api_key") === authMethod);
  const stamp = source.settings.find(s => s.key === `model_catalog_synced_at_${providerCode}_${authMethod}`)?.value;
  const syncedAt = z.object({ at: z.string().datetime() }).safeParse(stamp);
  const models: ChatListModel[] = rows.filter(m => category === "agent_triage" && authMethod === "api_key"
    ? m.capabilities.includes("triage_chat") || (["openrouter", "vercel"].includes(providerCode) && m.capabilities.includes("triage"))
    : m.capabilities.includes("chat")).map(m => ({
    model_id: m.model_id, name: m.name, provisional: false,
    reason: !m.is_active ? "inactive" : authMethod === "oauth" && !source.registry[providerCode]?.includes(m.model_id) ? "unsupported_model" : null,
  }));
  // A partial catalogue or a previous successful sync is authoritative, even
  // if every row is inactive or has since been removed.
  if (authMethod === "oauth" && rows.length === 0 && !syncedAt.success) {
    models.push(...(source.registry[providerCode] ?? []).map(model_id => ({ model_id, name: model_id, provisional: true, reason: null })));
  }
  return { models, synced_at: syncedAt.success ? syncedAt.data.at : null };
}

function availability(source: ChatPolicySnapshot, group: ChatListGroup): ChatListReason | null {
  const provider = source.providers.find(p => p.provider_code === group.provider_code);
  const status = source.statuses.find(s => s.provider_code === group.provider_code)?.status ?? "not_connected";
  // Missing providers still explain how to connect, while an explicit admin
  // deactivation always wins over credential availability.
  if (provider && !provider.is_active) return "inactive";
  if (group.auth_method === "api_key") {
    if (!source.apiKeys[group.provider_code]) return "api_key_absent";
  } else {
    if (!source.flags.feature_ai_provider_oauth) return "flag_off";
    if (status === "reauth_required") return "reauth_required";
    if (status === "disconnected") return "disconnected";
    if (status !== "connected") return "not_connected";
    if (!provider) return "inactive";
  }
  return group.models.some(m => !m.reason) ? null : "no_compatible_models";
}

export function buildChatListPolicy(source: ChatPolicySnapshot, category: "chat" | "agent_triage" = "chat") {
  const apiGroups: ChatListGroup[] = source.providers.map(p => ({
    provider_code: p.provider_code, auth_method: "api_key", name: p.name, reason: null,
    ...catalogueFor(source, p.provider_code, "api_key", category),
  }));
  const authGroups: ChatListGroup[] = Object.entries(AUTH_NAMES).map(([provider_code, name]) => ({
    provider_code, auth_method: "oauth", name, reason: null, ...catalogueFor(source, provider_code, "oauth", category),
  }));
  const groups = [...apiGroups, ...authGroups];
  for (const group of groups) {
    group.reason = availability(source, group);
    if (category === "agent_triage") {
      if (group.reason === "no_compatible_models") group.reason = "no_compatible_triage_models";
      if (group.auth_method === "oauth" && !supportsOutputCap({ provider: group.provider_code, authMethod: "oauth" })) group.reason = "oauth_max_tokens_unsupported";
      if (group.auth_method === "api_key" && group.provider_code === "claude") group.reason = "triage_api_unsupported";
    }
  }
  return { enabled: true as const, groups };
}

export const buildTriageListPolicy = (source: ChatPolicySnapshot) => buildChatListPolicy(source, "agent_triage");

export class ChatTierError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
const tierValue = z.object({ provider_code: z.string().trim().min(1).max(120), model_id: z.string().trim().min(1).max(300), auth_method: z.enum(["api_key", "oauth"]).optional() }).strict();
const tierRequest = tierValue.extend({ category: z.literal("chat"), slot: z.enum(["primary", "fallback", "fallback_2"]), expected: z.record(z.unknown()) }).strict();
export const CHAT_TIER_KEYS = ["default_ai_model_chat", "default_ai_model_chat_fallback", "default_ai_model_chat_fallback_2"] as const;
export const TRIAGE_TIER_KEYS = ["default_ai_model_agent_triage", "default_ai_model_agent_triage_fallback", "default_ai_model_agent_triage_fallback_2"] as const;

export function validateTriageTier(body: unknown, source: ChatPolicySnapshot) {
  const parsed = tierRequest.extend({ category: z.literal("agent_triage") }).safeParse(body);
  if (!parsed.success) throw new ChatTierError("invalid_triage_tier", 400);
  if (!source.flags.feature_ai_text_auth_lists) throw new ChatTierError("text_lists_disabled");
  const request = parsed.data;
  if (Object.keys(request.expected).some(key => !TRIAGE_TIER_KEYS.some(tierKey => key === tierKey))) throw new ChatTierError("invalid_triage_chain", 400);
  const group = buildTriageListPolicy(source).groups.find(g => g.provider_code === request.provider_code && g.auth_method === (request.auth_method ?? "api_key"));
  const model = group?.models.find(m => m.model_id === request.model_id);
  if (!group || group.reason || !model || model.reason) throw new ChatTierError(group?.reason ?? model?.reason ?? "model_unavailable");
  const value = request.auth_method === "oauth"
    ? { provider_code: request.provider_code, model_id: request.model_id, auth_method: "oauth" }
    : { provider_code: request.provider_code, model_id: request.model_id };
  const key = TRIAGE_TIER_KEYS[["primary", "fallback", "fallback_2"].indexOf(request.slot)];
  const next = { ...request.expected, [key]: value };
  let gap = false;
  let capped = false;
  try {
    for (const tierKey of TRIAGE_TIER_KEYS) {
      const tier = normalizeStoredTextTier(next[tierKey]);
      if (!tier) { gap = true; continue; }
      if (gap) throw new Error("Noncontiguous triage chain");
      capped ||= supportsOutputCap({ provider: tier.provider_code, authMethod: tier.auth_method });
    }
  } catch { throw new ChatTierError("invalid_triage_chain"); }
  if (!capped) throw new ChatTierError("oauth_max_tokens_unsupported");
  return { key, value, expected: request.expected };
}

export function validateChatTier(body: unknown, source: ChatPolicySnapshot) {
  const parsed = tierRequest.safeParse(body);
  if (!parsed.success) throw new ChatTierError("invalid_chat_tier", 400);
  if (!source.flags.feature_ai_text_auth_lists) throw new ChatTierError("text_lists_disabled");
  const request = parsed.data;
  const group = buildChatListPolicy(source).groups.find(g => g.provider_code === request.provider_code && g.auth_method === (request.auth_method ?? "api_key"));
  const model = group?.models.find(m => m.model_id === request.model_id);
  if (!group || group.reason || !model || model.reason) throw new ChatTierError(group?.reason ?? model?.reason ?? "model_unavailable");
  const value = request.auth_method === "oauth"
    ? { provider_code: request.provider_code, model_id: request.model_id, auth_method: "oauth" }
    : { provider_code: request.provider_code, model_id: request.model_id };
  const key = CHAT_TIER_KEYS[["primary", "fallback", "fallback_2"].indexOf(request.slot)];
  // Preserve the administrator's observed chain across ambiguous retries. A
  // fresh server snapshot would silently authorize replacing an unseen commit.
  const expected = request.expected;
  const next = { ...expected, [key]: value };
  let gap = false;
  for (const tierKey of CHAT_TIER_KEYS) {
    if (next[tierKey] == null) { gap = true; continue; }
    // The requested tier is validated strictly above; stored siblings only need the
    // fields this policy reads, so an extension field written by another writer stays valid.
    if (gap || !tierValue.passthrough().safeParse(next[tierKey]).success) throw new ChatTierError("invalid_chat_chain");
  }
  return { key, value, expected };
}
