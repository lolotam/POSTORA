/**
 * Native YouTube publisher: request construction and the resumable-upload
 * handshake with the YouTube Data API.
 *
 * Kept out of `process-post/index.ts` so the request Postora sends can be
 * asserted against a fake provider instead of against the live API.
 *
 * Reference for the fields used here:
 * https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
 */

import {
  effectiveYoutubePrivacy,
  YOUTUBE_DEFAULT_CATEGORY_ID,
  YOUTUBE_STALE_SCHEDULE_WARNING_MESSAGE,
  YOUTUBE_UPLOAD_UNCONFIRMED_OPTIONS,
  hasYoutubeScheduleRequest,
  resolveYoutubePublishAt,
} from "../_shared/youtubePublishOptions.ts";

const YOUTUBE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";

export interface YoutubeUploadRequestInput {
  /**
   * Post metadata, as stored on the post row.
   *
   * Typed as `object` because the caller owns a typed metadata interface, and
   * an interface is not assignable to an indexed record type.
   */
  metadata: object | null | undefined;
  title: string;
  description: string;
  tags: string[];
  /**
   * The instant the requested schedule is judged against.
   *
   * It is injected so a test can say what "now" is. A caller that has no
   * reason to care leaves it out, and the clock of the machine decides.
   */
  now?: Date;
}

export interface YoutubeUploadRequest {
  /** Fully built resumable-upload URL, including `part` and `notifySubscribers`. */
  url: string;
  /** The `part` values the request body is built for. */
  part: string;
  /** The request body sent to `videos.insert`. */
  body: Record<string, unknown>;
  notifySubscribers: boolean;
  /**
   * Options Postora sent that the YouTube Data API does not document as
   * settable at upload time. Reported so the caller is never told an option
   * was applied when the provider did not confirm it.
   */
  warnings: string[];
  /**
   * Set when the post asked for a native schedule that could not be honoured.
   *
   * The video was uploaded as private and not scheduled, and the customer is
   * told so instead of being told the schedule was applied.
   */
  scheduleWarning?: "stale_schedule" | null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

/** Reads a boolean option, falling back when it was not set to a boolean. */
function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function buildSnippet(
  input: YoutubeUploadRequestInput,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const snippet: Record<string, unknown> = {
    title: input.title.substring(0, 100),
    description: input.description.substring(0, 5000),
    tags: input.tags.slice(0, 500),
    categoryId: nonEmptyString(metadata.youtube_category) ?? YOUTUBE_DEFAULT_CATEGORY_ID,
  };

  const defaultLanguage = nonEmptyString(metadata.youtube_video_language);
  if (defaultLanguage) {
    snippet.defaultLanguage = defaultLanguage;
  }

  // `snippet.defaultAudioLanguage` is not listed among the properties
  // `videos.insert` can set. It is still sent, because the provider may honour
  // it, and it is reported as unconfirmed when it was sent.
  const defaultAudioLanguage = nonEmptyString(metadata.youtube_audio_language);
  if (defaultAudioLanguage) {
    snippet.defaultAudioLanguage = defaultAudioLanguage;
  }

  return snippet;
}

/**
 * What the post asked the provider to schedule.
 *
 * `none` is a post that asked for nothing, and it keeps the request exactly
 * what it was before native scheduling existed. `scheduled` is a time the
 * provider can be given. `stale` is a request that cannot be honoured, and it
 * ends private and unscheduled: the video is never published earlier or
 * wider than the post asked for.
 */
type YoutubeScheduleRequest =
  | { kind: "none" }
  | { kind: "scheduled"; publishAt: string }
  | { kind: "stale" };

/**
 * Reads the schedule the post asked for.
 *
 * The presence of the request is decided by one pure function, so the
 * publisher, the privacy helper and the evidence cannot disagree about it.
 */
function resolveRequestedSchedule(
  metadata: Record<string, unknown>,
  now: Date,
): YoutubeScheduleRequest {
  if (!hasYoutubeScheduleRequest(metadata)) return { kind: "none" };
  const resolved = resolveYoutubePublishAt(metadata.youtube_publish_at, now);
  return resolved.ok ? { kind: "scheduled", publishAt: resolved.publishAt } : { kind: "stale" };
}

function buildStatus(
  metadata: Record<string, unknown>,
  schedule: YoutubeScheduleRequest,
): Record<string, unknown> {
  const status: Record<string, unknown> = {
    // A scheduled upload is private whatever the privacy field says: YouTube
    // makes the video public at the scheduled time, and a schedule that
    // cannot be honoured never becomes public at all.
    privacyStatus: effectiveYoutubePrivacy(metadata),
    embeddable: booleanOrDefault(metadata.youtube_allow_embedding, true),
    publicStatsViewable: booleanOrDefault(metadata.youtube_public_stats_viewable, true),
    license: metadata.youtube_license === "creativeCommon" ? "creativeCommon" : "youtube",
  };

  if (schedule.kind === "scheduled") {
    status.publishAt = schedule.publishAt;
  }

  // An untouched checkbox is not a declaration. Sending an implicit `false`
  // would assert to Google that the creator checked "No" when they did not.
  // The dispatch fence refuses an upload that has not answered, so these
  // properties are only present when a real answer was stored.
  if (typeof metadata.youtube_made_for_kids === "boolean") {
    status.selfDeclaredMadeForKids = metadata.youtube_made_for_kids;
  }
  if (typeof metadata.youtube_contains_synthetic_media === "boolean") {
    status.containsSyntheticMedia = metadata.youtube_contains_synthetic_media;
  }
  return status;
}

/**
 * Builds the region restriction the post asked for.
 *
 * `contentDetails.regionRestriction` is not listed among the properties
 * `videos.insert` can set either. It is still sent, because the provider may
 * honour it, and it is reported as unconfirmed when it was sent.
 */
function buildRegionRestriction(
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const allowed = nonEmptyStringArray(metadata.youtube_allowed_countries);
  const blocked = nonEmptyStringArray(metadata.youtube_blocked_countries);
  if (!allowed && !blocked) return undefined;

  const regionRestriction: Record<string, unknown> = {};
  if (allowed) regionRestriction.allowed = allowed;
  if (blocked) regionRestriction.blocked = blocked;
  return regionRestriction;
}

/**
 * Builds the paid-product-placement declaration, but only when the caller
 * expressed one.
 *
 * Since 2026-11-16 an upload that omits this property is not declared free of
 * paid product placement, so Postora sends the declaration whenever the caller
 * stated one and stays silent when the caller did not.
 */
function buildPaidProductPlacement(
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof metadata.youtube_has_paid_product_placement === "boolean") {
    return { hasPaidProductPlacement: metadata.youtube_has_paid_product_placement };
  }
  // The old field stored false by default. Only true proves a user opted in.
  return metadata.youtube_has_paid_promotion === true
    ? { hasPaidProductPlacement: true }
    : undefined;
}

/** Names the options that were sent but that YouTube does not document as settable. */
function collectUnconfirmedWarnings(metadata: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  for (const entry of YOUTUBE_UPLOAD_UNCONFIRMED_OPTIONS) {
    const value = metadata[entry.metadataKey];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    warnings.push(
      `YouTube does not document ${entry.option} as settable at upload time. ` +
        `It was sent on a best-effort basis and may not have been applied.`,
    );
  }

  return warnings;
}

/**
 * Builds the `videos.insert` request from a post's metadata.
 *
 * The documented writable properties are listed below. Existing audio
 * language and region options are also sent on a best-effort basis.
 * `snippet.title`, `snippet.description`, `snippet.tags[]`,
 * `snippet.categoryId`, `snippet.defaultLanguage`, `status.embeddable`,
 * `status.license`, `status.privacyStatus`, `status.publicStatsViewable`,
 * `status.selfDeclaredMadeForKids`, `status.containsSyntheticMedia`,
 * `status.publishAt`, `recordingDetails.recordingDate` and
 * `paidProductPlacementDetails.hasPaidProductPlacement`.
 */
export function buildYoutubeUploadRequest(
  input: YoutubeUploadRequestInput,
): YoutubeUploadRequest {
  const metadata = (input.metadata ?? {}) as Record<string, unknown>;
  const schedule = resolveRequestedSchedule(metadata, input.now ?? new Date());
  const body: Record<string, unknown> = {
    snippet: buildSnippet(input, metadata),
    status: buildStatus(metadata, schedule),
  };
  const parts = ["snippet", "status"];

  const recordingDate = nonEmptyString(metadata.youtube_recording_date);
  if (recordingDate) {
    body.recordingDetails = { recordingDate };
    parts.push("recordingDetails");
  }

  const regionRestriction = buildRegionRestriction(metadata);
  if (regionRestriction) {
    body.contentDetails = { regionRestriction };
    parts.push("contentDetails");
  }

  const paidProductPlacement = buildPaidProductPlacement(metadata);
  if (paidProductPlacement) {
    body.paidProductPlacementDetails = paidProductPlacement;
    parts.push("paidProductPlacementDetails");
  }

  const notifySubscribers = booleanOrDefault(metadata.youtube_notify_subscribers, true);
  const part = parts.join(",");

  const warnings = collectUnconfirmedWarnings(metadata);
  if (schedule.kind === "stale") {
    warnings.push(YOUTUBE_STALE_SCHEDULE_WARNING_MESSAGE);
  }

  const request: YoutubeUploadRequest = {
    url: buildYoutubeUploadUrl({ part, notifySubscribers }),
    part,
    body,
    notifySubscribers,
    warnings,
  };
  if (schedule.kind === "stale") {
    request.scheduleWarning = "stale_schedule";
  }
  return request;
}

/**
 * The query settings of the provider request.
 *
 * They are not part of the body, and they decide what the request DOES: the
 * parts name the fields the provider is asked to write, and the subscriber
 * notification says whether the channel's subscribers are told about the
 * video.
 *
 * A worker that opens a provider session later has to make the SAME request,
 * so these settings travel with the session.
 */
export type YoutubeUploadRequestSettings = {
  mimeType?: string;
  /** The parts the request writes, as the provider names them. */
  part: string;
  /** Whether the channel's subscribers are told about the video. */
  notifySubscribers: boolean;
};

/**
 * The URL of the provider request.
 *
 * It is built here and nowhere else, so a request that is made later carries
 * the same parts and the same subscriber notification as the one that was
 * approved.
 */
export function buildYoutubeUploadUrl(settings: YoutubeUploadRequestSettings): string {
  return (
    `${YOUTUBE_UPLOAD_ENDPOINT}?uploadType=resumable&part=${settings.part}` +
    (settings.notifySubscribers ? "" : "&notifySubscribers=false")
  );
}

/**
 * The settings of a request that is rebuilt from a stored body.
 *
 * The parts are the names of the fields the body carries, and the subscriber
 * notification is the provider's default. It is the fallback for a session
 * that was admitted without its own settings: the request writes the fields
 * the body carries and notifies the way YouTube does by default.
 */
export function youtubeUploadSettingsFromBody(
  body: Record<string, unknown>,
): YoutubeUploadRequestSettings {
  const part = Object.keys(body).sort().join(",") || "snippet,status";
  return { part, notifySubscribers: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Translates a failed upload handshake into the message the caller shows. */
export function youtubeUploadErrorReason(errorData: unknown): unknown {
  const errors = asRecord(asRecord(errorData)?.error)?.errors;
  return Array.isArray(errors) ? asRecord(errors[0])?.reason : undefined;
}

export function uploadFailureMessage(status: number, errorData: unknown, statusText: string): string {
  const payload = asRecord(asRecord(errorData)?.error);
  const message = typeof payload?.message === "string" ? payload.message : undefined;
  if (status === 401) {
    return "YouTube authentication expired. Please reconnect your YouTube account.";
  }
  if (status === 403) {
    const reason = youtubeUploadErrorReason(errorData);
    if (reason === "quotaExceeded") {
      return "YouTube API quota exceeded. Please try again tomorrow.";
    }
    if (reason === "forbidden") {
      return "YouTube upload permission denied. Make sure your account has upload access.";
    }
    return `YouTube permission error: ${message || "Access denied"}`;
  }
  return `YouTube API error: ${message || statusText}`;
}
