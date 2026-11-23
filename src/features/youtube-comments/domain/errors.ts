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

/** Reasons the UI must treat as "the binding changed under a pending send". */
export const REBIND_REASONS: readonly Stage4Reason[] = ["not_found", "binding_changed"];

export function isRebindReason(reason: Stage4Reason | string | null | undefined): boolean {
  return !!reason && (REBIND_REASONS as readonly string[]).includes(reason);
}
