/**
 * The one place that decides whether a per-conversation mode override still
 * applies, and what an escalation writes.
 *
 * Every reader of ai_conversation_modes (the reply gate, the outbox recovery,
 * the inbox endpoints, the partner API) goes through activeOverrideMode. Until
 * 2026-09-13 an escalation wrote `human_first` with no expiry; with the only
 * human agent offline that silenced a conversation for good.
 */
export interface ConversationModeRow {
  mode: string;
  expires_at?: string | null;
}

export const DEFAULT_ESCALATION_TIMEOUT_MINUTES = 240;
export const MAX_ESCALATION_TIMEOUT_MINUTES = 10080;

export function isOverrideExpired(row: ConversationModeRow, nowMs: number): boolean {
  if (row.expires_at === null || row.expires_at === undefined) return false;
  const expiresMs = Date.parse(row.expires_at);
  // A value that will not parse is treated as expired: a broken timestamp must
  // never become a permanent mute.
  if (Number.isNaN(expiresMs)) return true;
  return expiresMs <= nowMs;
}

export function activeOverrideMode(
  row: ConversationModeRow | null | undefined,
  nowMs: number,
): string | null {
  if (!row) return null;
  return isOverrideExpired(row, nowMs) ? null : row.mode;
}

export interface EscalationOverride {
  mode: "human_first" | "human_then_ai";
  expires_at: string;
}

function clampTimeoutMinutes(timeoutMinutes: number | null | undefined): number {
  if (timeoutMinutes === null || timeoutMinutes === undefined || !Number.isFinite(timeoutMinutes) || timeoutMinutes === 0) {
    return DEFAULT_ESCALATION_TIMEOUT_MINUTES;
  }
  return Math.min(MAX_ESCALATION_TIMEOUT_MINUTES, Math.max(1, Math.trunc(timeoutMinutes)));
}

/**
 * Under human_then_ai a human gets an exclusive window only when one was
 * actually assigned; otherwise the assistant keeps answering and the row only
 * marks the escalation. Every other default mutes the assistant for the
 * window, which is what those modes ask for.
 */
export function escalationOverride(
  defaultMode: string | null | undefined,
  humanAssigned: boolean,
  timeoutMinutes: number | null | undefined,
  nowMs: number,
): EscalationOverride {
  const minutes = clampTimeoutMinutes(timeoutMinutes);
  const expires_at = new Date(nowMs + minutes * 60_000).toISOString();
  const mode = defaultMode === "human_then_ai" && !humanAssigned ? "human_then_ai" : "human_first";
  return { mode, expires_at };
}

/** The subset of a PostgREST client the override reader needs. */
export interface OverrideReaderClient {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export interface ConversationScope {
  userId: string;
  platform: string;
  conversationId: string;
}

interface StoredOverride extends ConversationModeRow {
  id: string;
}

// deno-lint-ignore no-explicit-any
function scoped(query: any, scope: ConversationScope) {
  return query
    .eq("user_id", scope.userId)
    .eq("platform", scope.platform)
    .eq("conversation_id", scope.conversationId);
}

/**
 * The override that applies to a conversation right now, with expired rows
 * cleaned up on the way.
 *
 * Reads the row, treats an expired one as absent, and deletes it -- but only
 * the exact row observed (id AND the expires_at it carried): an operator may
 * have replaced it meanwhile, and that newer decision wins, so when nothing
 * was deleted the row is read again and judged afresh. A failed read is
 * thrown, never turned into "no override": that would let the assistant
 * answer a chat a human has taken (AGENTS.md reviewer rule 3). A failed
 * delete is logged and ignored; the row is merely ignored until next time.
 *
 * Every query carries user_id because callers run as the service role and
 * tenancy has to be structural (ARCHITECTURE.md §24).
 */
export async function resolveConversationOverride(
  admin: OverrideReaderClient,
  scope: ConversationScope,
  nowMs: number,
): Promise<string | null> {
  const { data: row, error: readError } = await scoped(
    admin.from("ai_conversation_modes").select("id, mode, expires_at"),
    scope,
  ).maybeSingle();
  if (readError) throw readError;
  const observed = (row ?? null) as StoredOverride | null;
  const active = activeOverrideMode(observed, nowMs);
  if (!observed || active !== null) return active;

  const { data: deleted, error: deleteError } = await admin
    .from("ai_conversation_modes")
    .delete()
    .eq("id", observed.id)
    .eq("user_id", scope.userId)
    .eq("expires_at", observed.expires_at)
    .select("id");
  if (deleteError) {
    console.error("[conversation-mode] expired override cleanup failed:", String(deleteError.message ?? deleteError));
    return null;
  }
  if (Array.isArray(deleted) && deleted.length > 0) return null;

  const { data: replaced, error: replacedError } = await scoped(
    admin.from("ai_conversation_modes").select("id, mode, expires_at"),
    scope,
  ).maybeSingle();
  if (replacedError) throw replacedError;
  return activeOverrideMode((replaced ?? null) as StoredOverride | null, nowMs);
}
