/**
 * Replacing the thumbnail of an already published video (spec §8.2).
 *
 * Pure rules only: no React, no Supabase, no browser API. The MIME
 * allow-list itself is the edge operation's, re-exported through
 * `domain/types.ts`, so the picker and the server share one definition.
 */
import { DIRECT_THUMBNAIL_MIMES } from "./types";

/** One row of the creator's own media library, as the picker needs it. */
export interface YouTubeThumbnailCandidate {
  id: string;
  /** The name shown to the creator; the original upload name when known. */
  file_name: string;
  mime_type: string;
  file_type: string;
  file_size: number | null;
}

/**
 * Only a JPEG or PNG image can be sent straight to Google's `thumbnails.set`.
 * WebP, GIF and videos are refused here, and again by the server, which
 * verifies the stored bytes and not only the declared MIME.
 */
export function isDirectThumbnailCandidate(candidate: YouTubeThumbnailCandidate): boolean {
  return candidate.file_type === "image"
    && (DIRECT_THUMBNAIL_MIMES as readonly string[]).includes(candidate.mime_type);
}

/** What the creator is told after one thumbnail replacement attempt. */
export type YouTubeThumbnailOutcome =
  | "applied"
  | "thumbnail_not_allowed"
  | "media_not_usable"
  | "rate_limited"
  | "quota_exceeded"
  | "refused"
  | "outcome_unknown";

/**
 * Maps the server's stable refusal code to the outcome the creator sees.
 * Only `"outcome_unknown"` (or an unrecognized code) reports that the upload
 * may already have reached YouTube; definite pre-write or provider refusals
 * (`reconnect_required`, `not_found`, `upstream_unavailable`, `missing_scope`,
 * `provider_unsupported`, `write_not_enabled`, `internal_error`) report `"refused"`.
 */
export function thumbnailOutcomeFromErrorCode(code: string | null | undefined): YouTubeThumbnailOutcome {
  switch (code) {
    case "thumbnail_not_allowed":
      return "thumbnail_not_allowed";
    case "media_not_usable":
      return "media_not_usable";
    case "rate_limited":
      return "rate_limited";
    case "quota_exceeded":
      return "quota_exceeded";
    case "reconnect_required":
    case "not_found":
    case "upstream_unavailable":
    case "missing_scope":
    case "provider_unsupported":
    case "write_not_enabled":
    case "invalid_request":
    case "internal_error":
      return "refused";
    case "outcome_unknown":
    default:
      return "outcome_unknown";
  }
}
