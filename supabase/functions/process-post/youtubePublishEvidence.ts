/**
 * Compact, sanitized evidence for a YouTube publish result.
 *
 * A requested setting is not a verified outcome. Each follow-up has its own
 * nullable state, so a thumbnail failure never claims the comment failed and
 * an uncertain acknowledgement never claims either outcome succeeded.
 */

export type YoutubeFollowUpState = "not_requested" | "applied" | "skipped" | "failed" | "unknown";

export interface YoutubeFollowUpEvidence {
  state: YoutubeFollowUpState;
  reason: string | null;
}

export interface YoutubePublishEvidence {
  requested_privacy: string;
  effective_privacy: string;
  thumbnail: YoutubeFollowUpEvidence;
  first_comment: YoutubeFollowUpEvidence;
}

export interface YoutubeEvidenceInput {
  requestedPrivacy: string;
  effectivePrivacy?: string | null;
  thumbnailRequested: boolean;
  commentRequested: boolean;
  thumbnailState?: YoutubeFollowUpState;
  thumbnailReason?: string | null;
  commentState?: YoutubeFollowUpState;
  commentReason?: string | null;
}

const NEGATIVE_REASONS = new Set(["no_time", "authority_lost", "refused", "download_failed", "answer_lost"]);

function sanitizedReason(reason: string | null | undefined): string | null {
  return reason && NEGATIVE_REASONS.has(reason) ? reason : null;
}

export function youtubePublishEvidence(input: YoutubeEvidenceInput): YoutubePublishEvidence {
  return {
    requested_privacy: input.requestedPrivacy,
    effective_privacy: input.effectivePrivacy ?? "unknown",
    thumbnail: {
      state: input.thumbnailRequested ? input.thumbnailState ?? "unknown" : "not_requested",
      reason: input.thumbnailRequested ? sanitizedReason(input.thumbnailReason) : null,
    },
    first_comment: {
      state: input.commentRequested ? input.commentState ?? "unknown" : "not_requested",
      reason: input.commentRequested ? sanitizedReason(input.commentReason) : null,
    },
  };
}

/** Adds evidence under one additive key without disturbing existing keys. */
export function withYoutubePublishEvidence(
  responseData: Record<string, unknown>,
  evidence: YoutubePublishEvidence,
): Record<string, unknown> {
  return { ...responseData, youtube_publish_evidence: evidence };
}

/**
 * Builds evidence from the post's own metadata for the NATIVE settlement and
 * the resumed receipt, not only for the generic result writer. A state that
 * the settling worker did not actually observe stays unknown: a receipt
 * projection never infers that a thumbnail or comment succeeded.
 */
export function youtubeEvidenceFromMetadata(
  metadata: object | null | undefined,
  overrides: Partial<YoutubeEvidenceInput> = {},
): YoutubePublishEvidence {
  const values = (metadata ?? {}) as Record<string, unknown>;
  const thumbnailRequested = (typeof values.youtube_thumbnail_media_id === "string" && values.youtube_thumbnail_media_id.length > 0) ||
    (typeof values.youtube_thumbnail_url === "string" && values.youtube_thumbnail_url.length > 0);
  const commentRequested = typeof values.youtube_first_comment === "string" && values.youtube_first_comment.length > 0;
  return youtubePublishEvidence({
    requestedPrivacy: typeof values.youtube_visibility === "string" ? values.youtube_visibility : "private",
    thumbnailRequested,
    commentRequested,
    ...overrides,
  });
}
