import { z } from "npm:zod@3.23.8";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseTextLadder, legacyTextSlots, TextLadderError, textTierKeys, textTierSchema, textCategorySchema, TEXT_LAST_RESORT, supportsOutputCap } from "../_shared/textLadders.ts";
import { normalizeStoredTextTier, type StoredTextTier } from "../_shared/textTierValue.ts";
import { buildChatListPolicy, ChatTierError, type ChatPolicySnapshot } from "./chatListPolicy.ts";
import { chatActionDeps } from "./chatListActions.ts";

const requestSchema = z.object({ category: textCategorySchema, expected: z.record(z.unknown()), expected_chat: z.record(z.unknown()),
  slot: z.enum(["primary", "fallback", "fallback_2"]).optional(),
  provider_code: z.string().optional(), model_id: z.string().optional(), auth_method: z.enum(["api_key", "oauth"]).optional(),
}).strict();

export function validateTextMutation(body: unknown, source: ChatPolicySnapshot, action: "set-text-tier" | "inherit-text-category") {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw new ChatTierError("invalid_text_tier", 400);
  if (!source.flags.feature_ai_text_auth_lists || !source.flags.feature_ai_category_text_ladders) throw new ChatTierError("text_lists_disabled");
  const request = parsed.data;
  const keys = textTierKeys(request.category);
  if (Object.keys(request.expected).some(key => !keys.includes(key)) || Object.keys(request.expected_chat).some(key => !textTierKeys("chat").includes(key))) throw new ChatTierError("invalid_text_tier", 400);
  let chain = { ...request.expected };
  if (action === "inherit-text-category") {
    if (request.slot || request.provider_code || request.model_id || request.auth_method) throw new ChatTierError("invalid_text_tier", 400);
    chain = {};
  } else {
    const tier = textTierSchema.strict().safeParse({ provider_code: request.provider_code, model_id: request.model_id, auth_method: request.auth_method });
    if (!tier.success || !request.slot) throw new ChatTierError("invalid_text_tier", 400);
    chain[keys[["primary", "fallback", "fallback_2"].indexOf(request.slot)]] = tier.data.auth_method === "oauth"
      ? { provider_code: tier.data.provider_code, model_id: tier.data.model_id, auth_method: "oauth" }
      : { provider_code: tier.data.provider_code, model_id: tier.data.model_id };
    try { chain = Object.fromEntries(Object.entries(chain).map(([key, stored]) => [key, normalizeStoredTextTier(stored)])); }
    catch { throw new TextLadderError("invalid_text_chain"); }
  }
  const effective = action === "inherit-text-category" ? request.expected_chat : chain;
  const rows = Object.entries(effective).map(([key, value]) => ({ key, value }));
  let tiers: StoredTextTier[];
  if (action === "inherit-text-category") {
    const third = legacyTextSlots(rows, "chat", true)[2];
    const knownThird = third.auth_method === "oauth" ? Boolean(source.registry[third.provider_code]?.includes(third.model_id))
      : source.models.some(model => model.model_id === third.model_id && model.auth_method !== "oauth" && model.is_active &&
        source.providers.some(provider => provider.id === model.provider_id && provider.provider_code === third.provider_code));
    tiers = legacyTextSlots(rows, "chat", knownThird).filter(tier => tier !== null);
  } else {
    tiers = parseTextLadder(rows, request.category)!;
  }
  const groups = buildChatListPolicy(source).groups;
  // A changed tier must be usable. Unavailable stored siblings remain visible,
  // but cannot satisfy the effective cap requirement.
  const usable = (tier: z.infer<typeof textTierSchema>) => {
    const group = groups.find(group => group.provider_code === tier.provider_code && group.auth_method === (tier.auth_method ?? "api_key"));
    const model = group?.models.find(model => model.model_id === tier.model_id);
    return Boolean(group && !group.reason && model && !model.reason);
  };
  if (action === "set-text-tier") {
    const selected = textTierSchema.parse(chain[keys[["primary", "fallback", "fallback_2"].indexOf(request.slot!)]]);
    if (!usable(selected)) throw new ChatTierError("model_unavailable");
  }
  const floorUsable = Boolean(source.textFloorAvailable && source.providers.some(provider => ["google", "gemini"].includes(provider.provider_code) && provider.is_active));
  const candidates = tiers.map(tier => ({ provider: tier.provider_code, authMethod: tier.auth_method,
    usable: tier.provider_code === TEXT_LAST_RESORT.provider && tier.model_id === TEXT_LAST_RESORT.model && tier.auth_method !== "oauth" ? floorUsable : usable(tier) }));
  if (action === "set-text-tier" && tiers.length < 3) candidates.push({ ...TEXT_LAST_RESORT, authMethod: undefined, usable: floorUsable });
  if (!candidates.slice(0, 3).some(tier => tier.usable && supportsOutputCap(tier))) throw new ChatTierError("ai_output_cap_unsupported");
  return { category: request.category, chain, expected: request.expected, expectedChat: request.expected_chat };
}

export function textActionDeps(admin: SupabaseClient, userId: string, signal: AbortSignal) {
  return { ...chatActionDeps(admin, userId, signal), persist: async (mutation: ReturnType<typeof validateTextMutation>) => {
    signal.throwIfAborted();
    const { data, error } = await admin.rpc("write_ai_text_ladder", { p_category: mutation.category, p_chain: mutation.chain,
      p_expected: mutation.expected, p_expected_chat: mutation.expectedChat }).abortSignal(signal);
    if (error) throw new Error("Text ladder write failed");
    if (data !== true) throw new ChatTierError("configuration_changed_retry");
  } };
}

export async function runTextListAction(action: "set-text-tier" | "inherit-text-category", body: unknown, deps: ReturnType<typeof textActionDeps>) {
  try {
    if (!(await deps.isAdmin())) throw new ChatTierError("not_admin", 403);
    const flags = await deps.flags();
    if (!flags.feature_ai_text_auth_lists || !flags.feature_ai_category_text_ladders) throw new ChatTierError("text_lists_disabled");
    await deps.persist(validateTextMutation(body, await deps.snapshot(flags), action));
    return Response.json({ success: true });
  } catch (cause) {
    const reason = cause instanceof ChatTierError ? cause.code : cause instanceof TextLadderError ? cause.code : "configuration_read_or_write_failed";
    try { await deps.logRefusal(reason); } catch { console.warn({ event: "ai_text_refusal_log_failed", reason }); }
    return Response.json({ error: reason }, { status: cause instanceof ChatTierError ? cause.status : cause instanceof TextLadderError ? 409 : 503 });
  }
}
