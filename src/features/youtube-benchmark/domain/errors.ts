import { isYouTubeBenchmarkErrorCode } from "../../../../supabase/functions/youtube-channel-benchmark/contracts";
import type { YouTubeBenchmarkErrorCode } from "./types";

export class YouTubeBenchmarkError extends Error {
  readonly code: YouTubeBenchmarkErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: YouTubeBenchmarkErrorCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "YouTubeBenchmarkError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Turns a failed request into the one typed error the screen knows.
 *
 * Only the documented failure shape is accepted. An unknown shape or an
 * unknown code means the read itself failed, so it becomes
 * `upstream_unavailable` — never `not_found`, which would claim that a real
 * channel does not exist.
 */
export function toYouTubeBenchmarkError(payload: unknown): YouTubeBenchmarkError {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (isYouTubeBenchmarkErrorCode(record.error)) {
      const hint = record.retry_after_seconds;
      return new YouTubeBenchmarkError(
        record.error,
        typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? hint : null,
      );
    }
  }
  return new YouTubeBenchmarkError("upstream_unavailable");
}
