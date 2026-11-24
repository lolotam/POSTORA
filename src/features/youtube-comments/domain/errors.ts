import type { Stage4Reason } from "./types";

/**
 * A refusal from the Stage 4 surface, carrying the stable reason enum the
 * server defined. The UI maps reasons to copy; it never parses provider text.
 */
export class YouTubeCommentsError extends Error {
  constructor(public code: Stage4Reason | string, message?: string) {
    super(message ?? code);
    this.name = "YouTubeCommentsError";
  }
}

/**
 * Reasons that say a handle or cursor the browser holds is out of date (it
 * expired, or belongs to another binding). Repeating the same request cannot
 * help; the list has to be read again from its first page.
 */
export const STALE_CONTEXT_REASONS: readonly Stage4Reason[] = ["invalid_handle", "expired_handle", "cross_context"];

export function isStaleContextReason(reason: Stage4Reason | string | null | undefined): boolean {
  return !!reason && (STALE_CONTEXT_REASONS as readonly string[]).includes(reason);
}

/** Reasons the UI must treat as "the binding changed under a pending send". */
export const REBIND_REASONS: readonly Stage4Reason[] = ["not_found", "binding_changed"];

export function isRebindReason(reason: Stage4Reason | string | null | undefined): boolean {
  return !!reason && (REBIND_REASONS as readonly string[]).includes(reason);
}
