/**
 * Caption tracks of a published YouTube video (spec §11.1).
 *
 * Pure rules only: no React, no Supabase client, no DOM. The caption
 * contract itself is the edge function's, re-exported here so the gateway,
 * the UI and the server speak the same shapes (ARCHITECTURE.md §22).
 */
import type {
  YouTubeCaptionTrack,
  YouTubeCaptionsListData,
  YouTubeUploadCaptionData,
} from "../../../../supabase/functions/youtube-resources/contracts";
import { isDefinitiveRefusalCode } from "./errors";

export type { YouTubeCaptionTrack, YouTubeCaptionsListData, YouTubeUploadCaptionData };

/**
 * The ceiling of one caption file, in UTF-8 bytes (512 KB).
 *
 * The unit is bytes, not characters: an Arabic letter costs two bytes in
 * UTF-8, so a file that fits "by character count" can still be twice the
 * size on the wire. The browser measures the same way before it sends, so
 * an oversize file is refused in the page instead of costing a provider
 * call. The edge function enforces the identical ceiling in
 * `youtube-resources/captionFile.ts`; both numbers must stay equal.
 */
export const CAPTION_CONTENT_MAX_BYTES = 512 * 1024;

/** How many caption uploads one creator may make in a 24-hour window. */
export const CAPTION_DAILY_UPLOAD_ALLOWANCE = 2;

/** The longest caption track name YouTube accepts. */
export const CAPTION_TRACK_NAME_MAX_LENGTH = 150;

/**
 * The BCP-47 shape the edge function validates: a two- or three-letter
 * language, optionally followed by up to two subtags.
 */
export const CAPTION_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** The caption file formats YouTube accepts. */
export type YouTubeCaptionFormat = "srt" | "vtt";

/**
 * The size of a caption file in UTF-8 bytes.
 *
 * `TextEncoder` is the platform's own encoding primitive (browsers, Node
 * and Deno all provide it), not a browser-only API: the same measurement
 * runs in the page and on the server, so the two can never disagree.
 */
export function measureCaptionUtf8Bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

/**
 * The format of a caption file, read from its name. Anything that is not
 * `.srt` or `.vtt` is refused here rather than sent to YouTube.
 */
export function inferCaptionFormatFromFileName(fileName: string): YouTubeCaptionFormat | null {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith(".srt")) return "srt";
  if (lowered.endsWith(".vtt")) return "vtt";
  return null;
}

/** What one caption upload attempt produced, in the creator's words. */
export type YouTubeCaptionUploadOutcome =
  | "uploaded"
  | "caption_conflict"
  | "caption_invalid"
  | "rate_limited"
  | "quota_exceeded"
  | "refused"
  | "outcome_unknown";

/**
 * What one upload attempt produced: the outcome, and the track the
 * provider confirmed when there is one. The track lets the UI show the new
 * row without paying for another caption list (50 provider units).
 */
export interface YouTubeCaptionUploadResult {
  outcome: YouTubeCaptionUploadOutcome;
  track: YouTubeCaptionTrack | null;
}

/**
 * Maps the server's stable refusal code to the outcome the creator sees.
 *
 * Only `outcome_unknown` (or an unrecognized code) reports that the upload
 * may already have reached YouTube; every definite refusal reports that
 * nothing was written.
 */
export function captionOutcomeFromErrorCode(code: string | null | undefined): YouTubeCaptionUploadOutcome {
  switch (code) {
    case "caption_conflict":
      return "caption_conflict";
    case "caption_invalid":
      return "caption_invalid";
    case "rate_limited":
      return "rate_limited";
    case "quota_exceeded":
      return "quota_exceeded";
    case "outcome_unknown":
      return "outcome_unknown";
    default:
      return code !== null && code !== undefined && isDefinitiveRefusalCode(code)
        ? "refused"
        : "outcome_unknown";
  }
}

/**
 * Why one caption list could not be read (spec §14.1.5).
 *
 * A caption list costs 50 provider units and one of ten daily reads, so the
 * creator is told which of those they spent: a missing permission, a spent
 * allowance, a video that is gone and a provider that did not answer are four
 * different problems with four different fixes.
 */
export type CaptionListFailure =
  | "missing_scope"
  | "reconnect_required"
  | "rate_limited"
  | "quota_exceeded"
  | "not_found"
  | "unavailable"
  | "retryable"
  | "failed";

/**
 * Maps the server's stable refusal code to the reason the list failed.
 *
 * `retryable` is reserved for a provider that did not answer: the other
 * refusals would fail the same way a second time, and repeating them spends
 * provider units to reach the same answer.
 */
export function captionListFailureFromErrorCode(code: string | null | undefined): CaptionListFailure {
  switch (code) {
    case "missing_scope":
      return "missing_scope";
    case "reconnect_required":
      return "reconnect_required";
    case "rate_limited":
      return "rate_limited";
    case "quota_exceeded":
      return "quota_exceeded";
    case "not_found":
      return "not_found";
    case "write_not_enabled":
    case "provider_unsupported":
    case "invalid_request":
      return "unavailable";
    case "upstream_unavailable":
      return "retryable";
    default:
      return "failed";
  }
}
