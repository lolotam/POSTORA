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
