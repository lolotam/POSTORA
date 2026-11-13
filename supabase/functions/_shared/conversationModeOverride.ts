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
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
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
 * Reads the row, treats an expired one as absent, and expires it -- but only
 * the exact row observed (id AND the expires_at it carried): an operator may
 * have replaced it meanwhile, and that newer decision wins, so when nothing
 * was expired the row is read again and judged afresh. A failed read is
 * thrown, never turned into "no override": that would let the assistant
 * answer a chat a human has taken (AGENTS.md reviewer rule 3).
 *
 * A failed EXPIRY is not a cleanup that may be skipped either. The expiry RPC
 * is the only thing that leaves the thread marked, so when it fails the marker
 * is not durable yet and the turn must not go on as if the window had ended
 * cleanly. The scoped row is read again to tell the two failures apart:
 *
 *   * an override an operator installed meanwhile is a real takeover and wins,
 *     so that mode is returned and the assistant stays silent;
 *   * the same expired row means the marker is still unstamped, so the turn
 *     fails and is retried once the expiry lands;
 *   * no row at all means the expiry did land, and the window is simply over.
 *
 * An expiry that did NOT happen is read the same way. The RPC returns false when the
 * database's clock does not consider the row expired -- the edge's clock did -- and
 * then nothing was removed and no marker was stamped. That is not an absent window, so
 * the row is read again and judged the same way: a takeover wins, the same expired row
 * means the marker is not durable yet and the turn fails, and no row at all means the
 * window is over.
 *
 * Expiry is the expire_conversation_mode RPC, not a plain delete: whichever
 * function happens to observe a silent (human_first) window ending must leave
 * the thread marked, in the same statement, so the assistant's first reply
 * afterwards knows the customer may have waited unanswered.
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

  const { data: expired, error: expireError } = await admin.rpc("expire_conversation_mode", {
    p_mode_id: observed.id,
    p_user_id: scope.userId,
    p_expires_at: observed.expires_at,
  });
  if (expireError) {
    console.error("[conversation-mode] expired override cleanup failed:", String(expireError.message ?? expireError));
    // The write that stamps the escalation marker failed, so its state is unknown.
    // Read the scoped row again rather than guessing.
    const { data: reread, error: rereadError } = await scoped(
      admin.from("ai_conversation_modes").select("id, mode, expires_at"),
      scope,
    ).maybeSingle();
    if (rereadError) throw rereadError;
    const current = (reread ?? null) as StoredOverride | null;
    const currentActive = activeOverrideMode(current, nowMs);
    // A takeover installed meanwhile is a real human decision: it wins.
    if (currentActive !== null) return currentActive;
    if (current) {
      // The window is still there and still expired: the marker was never stamped, so
      // this turn fails and is retried once the expiry lands.
      throw new Error("conversation mode expiry failed; the escalation marker is not durable yet");
    }
    // The row is gone: the expiry landed after all.
    return null;
  }
  if (expired === true) return null;

  // The expiry did NOT happen: the database neither removed the row nor stamped the
  // marker. That is not an absent window -- the edge's clock said the window was over,
  // the database's clock did not -- so the state the database holds decides, and the row
  // is read again to see it:
  //
  //   * an override an operator installed meanwhile is a real takeover and wins, so
  //     that mode is returned and the assistant stays silent;
  //   * the same expired row means the marker is still unstamped, so the turn fails and
  //     is retried once the expiry lands;
  //   * no row at all means the row is gone, and the window is simply over.
  const { data: replaced, error: replacedError } = await scoped(
    admin.from("ai_conversation_modes").select("id, mode, expires_at"),
    scope,
  ).maybeSingle();
  if (replacedError) throw replacedError;
  const current = (replaced ?? null) as StoredOverride | null;
  const currentActive = activeOverrideMode(current, nowMs);
  if (currentActive !== null) return currentActive;
  if (current) {
    throw new Error("conversation mode expiry did not happen; the escalation marker is not durable yet");
  }
  return null;
}
