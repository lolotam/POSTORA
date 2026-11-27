import { isYouTubeResourceErrorCode, type YouTubeResourceErrorCode } from "./types";

export class YouTubeResourceError extends Error {
  readonly code: YouTubeResourceErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: YouTubeResourceErrorCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "YouTubeResourceError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Accepts only the documented failure shape; an unknown shape or an unknown
// code means the server-side read failed, so it becomes upstream_unavailable.
export function toYouTubeResourceError(
  payload: unknown,
  fallbackCode: "upstream_unavailable" | "outcome_unknown" = "upstream_unavailable",
): YouTubeResourceError {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (isYouTubeResourceErrorCode(record.error)) {
      const hint = record.retry_after_seconds;
      return new YouTubeResourceError(
        record.error,
        typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? hint : null,
      );
    }
  }
  return new YouTubeResourceError(fallbackCode);
}

// "internal_error" is NOT retried: the server-side read itself just failed,
// and a repeat spends provider units to reach the same answer.
export function isRetryableYouTubeError(code: YouTubeResourceErrorCode): boolean {
  return code === "upstream_unavailable";
}

/**
 * The refusals that mean "nothing was written": the connection, the scope
 * or the request itself was turned down before any change reached YouTube.
 *
 * Every outcome mapper in this feature shares this one list, so a refusal
 * code cannot be added to one mapper and forgotten in the other — a missed
 * code would tell the creator that something may have been uploaded when
 * nothing was.
 */
const DEFINITIVE_REFUSAL_CODES = [
  "reconnect_required",
  "not_found",
  "unauthorized",
  "upstream_unavailable",
  "missing_scope",
  "provider_unsupported",
  "write_not_enabled",
  "invalid_request",
  "internal_error",
] as const;

export function isDefinitiveRefusalCode(code: string): boolean {
  return (DEFINITIVE_REFUSAL_CODES as readonly string[]).includes(code);
}
