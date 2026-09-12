// Private mode keys never cross this boundary. The published id is always
// messaging_cache.id, resolved under workspace AND the current bound set.
import { AgentConfigOpError, type AgentConfigContext } from "../../_shared/agentConfigOps.ts";
import { activeOverrideMode } from "../../_shared/conversationModeOverride.ts";
import { encodeId } from "./ids.ts";
import { encodeCursor, keysetFilter, type PageRequest } from "./pagination.ts";

export interface ModeConversation {
  id: string;
  social_account_id: string;
  user_id: string;
  platform: string;
  conversation_id: string;
  last_message_at: string;
}
interface ModeRow { mode: string; updated_at: string | null; expires_at?: string | null; }
const MODE_COLUMNS = "mode, updated_at, expires_at";
const CACHE_COLUMNS = "id, social_account_id, user_id, platform, conversation_id, last_message_at";
const STORED_MODES = ["ai_first", "human_first", "human_then_ai"];
const SCAN_BATCH = 100;
const SCAN_BUDGET = 500;

/** Table constraints, deliberately narrower than isAiAgentPlatform. */
export function validateRulePlatform(platform: string): void {
  if (!["whatsapp", "facebook", "instagram"].includes(platform)) {
    throw new AgentConfigOpError("invalid_request", "Invalid automation rule platform");
  }
}
function presentMode(conversation: ModeConversation, row: ModeRow | null) {
  // An expired escalation override reads as no override; expires_at is
  // returned so the caller can tell an escalation window from a manual choice.
  return {
    id: encodeId("conv", conversation.id),
    platform: conversation.platform,
    mode: row && activeOverrideMode(row, Date.now()) !== null ? row.mode : null,
    updated_at: row?.updated_at ?? null,
    expires_at: row?.expires_at ?? null,
  };
}
function scopedMode(ctx: AgentConfigContext, conversation: ModeConversation) {
  return ctx.admin.from("ai_conversation_modes").select(MODE_COLUMNS)
    .eq("user_id", conversation.user_id).eq("platform", conversation.platform)
    .eq("conversation_id", conversation.conversation_id);
}
export async function getConversationMode(ctx: AgentConfigContext, conversation: ModeConversation) {
  const { data, error } = await scopedMode(ctx, conversation).maybeSingle();
  if (error) throw new AgentConfigOpError("internal_error", "Unable to read conversation mode");
  return presentMode(conversation, data);
}
export async function setConversationMode(ctx: AgentConfigContext, conversation: ModeConversation, body: Record<string, unknown>) {
  validateRulePlatform(conversation.platform);
  if (Object.keys(body).some((key) => key !== "mode") || !(body.mode === null || body.mode === "default" || (typeof body.mode === "string" && STORED_MODES.includes(body.mode)))) {
    throw new AgentConfigOpError("invalid_request", "Invalid AI conversation mode");
  }
  if (body.mode === null || body.mode === "default") {
    const { error } = await ctx.admin.from("ai_conversation_modes").delete()
      .eq("user_id", conversation.user_id).eq("platform", conversation.platform)
      .eq("conversation_id", conversation.conversation_id);
    if (error) throw new Error("Mode delete outcome unknown");
    return presentMode(conversation, null);
  }
  const { data, error } = await ctx.admin.from("ai_conversation_modes").upsert({
    user_id: conversation.user_id, platform: conversation.platform,
    conversation_id: conversation.conversation_id, mode: body.mode,
    expires_at: null,
  }, { onConflict: "user_id,platform,conversation_id" }).select(MODE_COLUMNS).single();
  if (error || !data) throw new Error("Mode write outcome unknown");
  return presentMode(conversation, data);
}

/** Keyset on the cache, not on mode.updated_at: removing orphaned mode rows
 * cannot shift this ordering. Stop after a fixed scan budget for class A.
 * Sparse pages can carry a cursor even when no override was found. */
export async function listConversationModes(ctx: AgentConfigContext, accountIds: string[], page: PageRequest) {
  const data: ReturnType<typeof presentMode>[] = [];
  if (!accountIds.length) return { data, next_cursor: null };
  let cursor = page.cursor;
  let lastIncluded = cursor;
  for (let scanned = 0; scanned < SCAN_BUDGET; scanned += SCAN_BATCH) {
    let query = ctx.admin.from("messaging_cache").select(CACHE_COLUMNS)
      .eq("workspace_id", ctx.workspaceId).eq("platform", ctx.platform)
      .in("social_account_id", accountIds).not("last_message_at", "is", null)
      .order("last_message_at", { ascending: false }).order("id", { ascending: false }).limit(SCAN_BATCH);
    if (cursor) query = query.or(keysetFilter("last_message_at", cursor));
    const { data: rows, error } = await query;
    if (error) throw new AgentConfigOpError("internal_error", "Unable to read conversations");
    const conversations = (rows ?? []) as ModeConversation[];
    // Group by owner so a coincident text key held by another owner cannot
    // resolve. Each IN filter is bounded by the cache batch size.
    const modes = new Map<string, Map<string, ModeRow>>();
    for (const owner of new Set(conversations.map((row) => row.user_id))) {
      const keys = conversations.filter((row) => row.user_id === owner).map((row) => row.conversation_id);
      const { data: overrides, error: modeError } = await ctx.admin.from("ai_conversation_modes")
        .select("conversation_id, " + MODE_COLUMNS).eq("user_id", owner).eq("platform", ctx.platform).in("conversation_id", keys);
      if (modeError) throw new AgentConfigOpError("internal_error", "Unable to read conversation modes");
      modes.set(owner, new Map((overrides ?? []).map((row: ModeRow & { conversation_id: string }) => [row.conversation_id, row])));
    }
    for (const conversation of conversations) {
      cursor = { timestamp: conversation.last_message_at, id: conversation.id };
      const mode = modes.get(conversation.user_id)?.get(conversation.conversation_id);
      if (!mode) continue;
      if (data.length === page.limit) return { data, next_cursor: encodeCursor(lastIncluded!) };
      data.push(presentMode(conversation, mode));
      lastIncluded = cursor;
    }
    if (conversations.length < SCAN_BATCH) return { data, next_cursor: null };
  }
  return { data, next_cursor: cursor ? encodeCursor(cursor) : null };
}
