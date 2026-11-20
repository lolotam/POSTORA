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
export function toYouTubeResourceError(payload: unknown): YouTubeResourceError {
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
  return new YouTubeResourceError("upstream_unavailable");
}

// "internal_error" is NOT retried: the server-side read itself just failed,
// and a repeat spends provider units to reach the same answer.
export function isRetryableYouTubeError(code: YouTubeResourceErrorCode): boolean {
  return code === "upstream_unavailable";
}
