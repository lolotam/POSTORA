import { z } from "npm:zod@3.23.8";
import type { AiTextFlags } from "../_shared/aiOAuth/textFlags.ts";

export type ChatListReason = "flag_off" | "inactive" | "not_connected" | "reauth_required" | "disconnected" | "api_key_absent" | "no_compatible_models";
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
  registry: Record<string, string[]>;
}

const AUTH_NAMES: Record<string, string> = { claude: "Claude subscription", openai: "OpenAI Codex subscription", openrouter: "OpenRouter Auth" };

function catalogueFor(source: ChatPolicySnapshot, providerCode: string, authMethod: "api_key" | "oauth") {
  const provider = source.providers.find(p => p.provider_code === providerCode);
  const rows = source.models.filter(m => m.provider_id === provider?.id && (m.auth_method ?? "api_key") === authMethod);
  const stamp = source.settings.find(s => s.key === `model_catalog_synced_at_${providerCode}_${authMethod}`)?.value;
  const syncedAt = z.object({ at: z.string().datetime() }).safeParse(stamp);
  const models: ChatListModel[] = rows.filter(m => m.capabilities.includes("chat")).map(m => ({
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

export function buildChatListPolicy(source: ChatPolicySnapshot) {
  const apiGroups: ChatListGroup[] = source.providers.map(p => ({
    provider_code: p.provider_code, auth_method: "api_key", name: p.name, reason: null,
    ...catalogueFor(source, p.provider_code, "api_key"),
  }));
  const authGroups: ChatListGroup[] = Object.entries(AUTH_NAMES).map(([provider_code, name]) => ({
    provider_code, auth_method: "oauth", name, reason: null, ...catalogueFor(source, provider_code, "oauth"),
  }));
  const groups = [...apiGroups, ...authGroups];
  for (const group of groups) group.reason = availability(source, group);
  return { enabled: true as const, groups };
}

export class ChatTierError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
const tierValue = z.object({ provider_code: z.string().trim().min(1).max(120), model_id: z.string().trim().min(1).max(300), auth_method: z.enum(["api_key", "oauth"]).optional() }).strict();
const tierRequest = tierValue.extend({ category: z.literal("chat"), slot: z.enum(["primary", "fallback", "fallback_2"]) }).strict();
export const CHAT_TIER_KEYS = ["default_ai_model_chat", "default_ai_model_chat_fallback", "default_ai_model_chat_fallback_2"] as const;

export function chatTierSnapshot(settings: ChatPolicySnapshot["settings"]) {
  return Object.fromEntries(CHAT_TIER_KEYS.flatMap(key => {
    const row = settings.find(s => s.key === key);
    return row ? [[key, row.value]] : [];
  }));
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
  const expected = chatTierSnapshot(source.settings);
  const next = { ...expected, [key]: value };
  let gap = false;
  for (const tierKey of CHAT_TIER_KEYS) {
    if (next[tierKey] == null) { gap = true; continue; }
    if (gap || !tierValue.safeParse(next[tierKey]).success) throw new ChatTierError("invalid_chat_chain");
  }
  return { key, value, expected };
}
