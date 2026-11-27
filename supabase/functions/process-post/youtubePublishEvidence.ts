/**
 * Compact, sanitized evidence for a YouTube publish result.
 *
 * A requested setting is not a verified outcome. Each follow-up has its own
 * nullable state, so a thumbnail failure never claims the comment failed and
 * an uncertain acknowledgement never claims either outcome succeeded.
 */

import {
  effectiveYoutubePrivacy,
  hasYoutubeScheduleRequest,
  resolveYoutubePublishAt,
} from "../_shared/youtubePublishOptions.ts";

export type YoutubeFollowUpState = "not_requested" | "applied" | "skipped" | "failed" | "unknown";

export interface YoutubeFollowUpEvidence {
  state: YoutubeFollowUpState;
  reason: string | null;
}

export interface YoutubePublishEvidence {
  requested_privacy: string;
  effective_privacy: string;
  /**
   * The publish time the post asked for, whether or not it was honoured.
   *
   * It is the raw value the post carried, so a reader can see what was
   * asked for even when the answer was "no".
   */
  requested_publish_at: string | null;
  /** Whether the video was uploaded with a schedule the provider accepted. */
  scheduled: boolean;
  /** Why a schedule was asked for and not given, when that happened. */
  schedule_warning: "stale_schedule" | null;
  thumbnail: YoutubeFollowUpEvidence;
  first_comment: YoutubeFollowUpEvidence;
}

export interface YoutubeEvidenceInput {
  requestedPrivacy: string;
  effectivePrivacy?: string | null;
  requestedPublishAt?: string | null;
  scheduled?: boolean;
  scheduleWarning?: "stale_schedule" | null;
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
    requested_publish_at: input.requestedPublishAt ?? null,
    scheduled: input.scheduled ?? false,
    schedule_warning: input.scheduleWarning === "stale_schedule" ? "stale_schedule" : null,
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

/** The schedule the evidence records. */
interface YoutubeScheduleEvidence {
  requestedPublishAt: string | null;
  scheduled: boolean;
  scheduleWarning: "stale_schedule" | null;
}

/**
 * The publish time the post carried, as it was written.
 *
 * A value of the wrong type is still an attempt to schedule, so it is kept as
 * text: the reader sees what was asked for, not that it was nonsense.
 */
function requestedPublishAtOf(values: Record<string, unknown>): string | null {
  const value = values.youtube_publish_at;
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  return String(value);
}

/**
 * What the schedule evidence says.
 *
 * The caller that observed the upload wins: it knows whether the provider
 * took the schedule. Only when nobody observed it is the post's own value
 * read, so a schedule that could never have been honoured is reported as
 * such instead of as an ordinary unscheduled upload.
 */
function scheduleEvidenceOf(
  values: Record<string, unknown>,
  overrides: Partial<YoutubeEvidenceInput>,
): YoutubeScheduleEvidence {
  const rawPublishAt = requestedPublishAtOf(values);

  if (overrides.scheduleWarning === "stale_schedule") {
    return {
      requestedPublishAt: overrides.requestedPublishAt ?? rawPublishAt,
      scheduled: false,
      scheduleWarning: "stale_schedule",
    };
  }

  if (overrides.scheduled !== undefined) {
    return {
      requestedPublishAt: overrides.requestedPublishAt ?? rawPublishAt,
      scheduled: overrides.scheduled,
      scheduleWarning: null,
    };
  }

  const resolved = hasYoutubeScheduleRequest(values)
    ? resolveYoutubePublishAt(values.youtube_publish_at)
    : null;

  if (resolved?.ok) {
    return { requestedPublishAt: resolved.publishAt, scheduled: true, scheduleWarning: null };
  }

  if (resolved) {
    // The post asked for a schedule that cannot be honoured.
    return { requestedPublishAt: rawPublishAt, scheduled: false, scheduleWarning: "stale_schedule" };
  }

  return {
    requestedPublishAt: overrides.requestedPublishAt ?? null,
    scheduled: false,
    scheduleWarning: null,
  };
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
  const schedule = scheduleEvidenceOf(values, overrides);
  return youtubePublishEvidence({
    // The privacy that is recorded is the privacy that was asked for, and a
    // scheduled upload is private whatever the privacy field says.
    requestedPrivacy: overrides.requestedPrivacy ?? effectiveYoutubePrivacy(values),
    requestedPublishAt: schedule.requestedPublishAt,
    scheduled: schedule.scheduled,
    scheduleWarning: schedule.scheduleWarning,
    thumbnailRequested: overrides.thumbnailRequested ?? thumbnailRequested,
    commentRequested: overrides.commentRequested ?? commentRequested,
    effectivePrivacy: overrides.effectivePrivacy,
    thumbnailState: overrides.thumbnailState,
    thumbnailReason: overrides.thumbnailReason,
    commentState: overrides.commentState,
    commentReason: overrides.commentReason,
  });
}
