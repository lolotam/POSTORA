import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";

/** Expected refusal. `message` is safe to return to the client. */
export class ReviewError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ReviewError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const RPC_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  TIKTOK_REVIEW_NOT_FOUND: {
    status: 404,
    code: "NOT_FOUND",
    message: "That draft could not be found.",
  },
  TIKTOK_REVIEW_REVISION_CONFLICT: {
    status: 409,
    code: "REVISION_CONFLICT",
    message: "This draft was updated. Reload it and try again.",
  },
  TIKTOK_REVIEW_INVALID_STATE: {
    status: 409,
    code: "INVALID_STATE",
    message: "This draft can't be changed from its current state.",
  },
  TIKTOK_REVIEW_ACCOUNT_NOT_FOUND: {
    status: 404,
    code: "ACCOUNT_NOT_FOUND",
    message: "That TikTok account isn't connected.",
  },
  TIKTOK_REVIEW_MEDIA_REQUIRED: {
    status: 422,
    code: "MEDIA_REQUIRED",
    message: "Add a video before publishing.",
  },
  TIKTOK_REVIEW_REASON_REQUIRED: {
    status: 422,
    code: "REASON_REQUIRED",
    message: "Enter a reason to reject this draft.",
  },
  TIKTOK_REVIEW_SCHEDULE_INVALID: {
    status: 422,
    code: "SCHEDULE_INVALID",
    message: "Choose a future time to schedule this post.",
  },
};

function textFields(error: unknown): { code: string; texts: string[] } {
  if (typeof error !== "object" || error === null) {
    return { code: "", texts: [] };
  }
  const row = error as Record<string, unknown>;
  const code = typeof row.code === "string" ? row.code : "";
  const texts = [row.message, row.details, row.hint].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (error instanceof Error && error.message && !texts.includes(error.message)) {
    texts.unshift(error.message);
  }
  return { code, texts };
}

/**
 * Maps a PostgREST/Postgres failure onto the review contract.
 * Known review codes and the media foreign key become stable responses.
 * Everything else is sanitized and stays INTERNAL — the database text is not returned.
 */
export function mapDatabaseError(error: unknown): ReviewError {
  const { code, texts } = textFields(error);
  if (code === "23503") {
    return new ReviewError(422, "MEDIA_NOT_OWNED", "Choose a video from your library.");
  }
  if (texts.some((text) => text.startsWith("POST_QUOTA_"))) {
    return new ReviewError(429, "QUOTA_EXCEEDED", "You've reached your posting limit.");
  }
  for (const text of texts) {
    const match = text.match(/TIKTOK_REVIEW_[A-Z0-9_]+/);
    const mapped = match ? RPC_ERRORS[match[0]] : undefined;
    if (mapped) return new ReviewError(mapped.status, mapped.code, mapped.message);
  }
  return new ReviewError(500, "INTERNAL", sanitizeErrorMessage(error));
}
