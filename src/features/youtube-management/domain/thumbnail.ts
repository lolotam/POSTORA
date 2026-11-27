/**
 * Replacing the thumbnail of an already published video (spec §8.2).
 *
 * Pure rules only: no React, no Supabase, no browser API. The MIME
 * allow-list itself is the edge operation's, re-exported through
 * `domain/types.ts`, so the picker and the server share one definition.
 */
import { DIRECT_THUMBNAIL_MIMES } from "./types";
import { isDefinitiveRefusalCode } from "./errors";

/**
 * YouTube's 2 MiB maximum thumbnail file size.
 *
 * The edge function's own constant, re-exported so the page and the server can
 * never disagree about it (ARCHITECTURE.md §22).
 */
import { THUMBNAIL_MAX_BYTES } from "../../../../supabase/functions/youtube-resources/thumbnailMedia";

export { THUMBNAIL_MAX_BYTES };

/** One row of the creator's own media library, as the picker needs it. */
export interface YouTubeThumbnailCandidate {
  id: string;
  /** The name shown to the creator; the original upload name when known. */
  file_name: string;
  mime_type: string;
  file_type: string;
  file_size: number | null;
  /** Display only: where the browser can show the image. Never sent to YouTube. */
  preview_url?: string | null;
}

/**
 * YouTube's 2 MiB maximum thumbnail file size.
 *
 * The same ceiling the edge function enforces on the stored bytes, so a file
 * the page accepts is a file the server accepts.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Identifies a JPEG or PNG from its leading bytes.
 *
 * The declared MIME of a file is what the browser claims; the magic bytes are
 * what the file is. Google reads the bytes, so the bytes decide.
 */
export function sniffThumbnailType(head: Uint8Array): "image/jpeg" | "image/png" | null {
  if (head.byteLength >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    head.byteLength >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((byte, index) => head[index] === byte)
  ) {
    return "image/png";
  }
  return null;
}

/** The MIME types a declared file type may name. */
const DECLARED_THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png"]);

/** Why a picked image was refused before it was stored. */
export type ThumbnailFileFailureReason = "not_jpeg_png" | "too_large" | "type_mismatch";

/** The verdict on one picked image. */
export type ThumbnailFileCheck =
  | { ok: true; mimeType: "image/jpeg" | "image/png" }
  | { ok: false; reason: ThumbnailFileFailureReason };

/**
 * Whether the image was refused.
 *
 * A type guard rather than an inline `!check.ok`: this repository compiles
 * without `strictNullChecks`, where TypeScript does not narrow a union by a
 * boolean discriminant.
 */
export function isThumbnailFileFailure(
  check: ThumbnailFileCheck,
): check is { ok: false; reason: ThumbnailFileFailureReason } {
  return check.ok === false;
}

/**
 * Checks one file before it is stored.
 *
 * The order matters: an unsupported type is refused before the bytes are
 * sniffed, and a mismatch between the declared type and the bytes is a
 * different refusal from an unsupported type, because the creator can fix one
 * by picking a different file and the other by re-saving the same picture in
 * the right format.
 */
export function checkThumbnailFile(input: {
  declaredType: string;
  size: number;
  head: Uint8Array;
}): ThumbnailFileCheck {
  const declared = input.declaredType.toLowerCase().split(";")[0].trim();
  // "image/jpg" is what some browsers and tools write for a JPEG.
  const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
  if (normalized !== "" && !DECLARED_THUMBNAIL_TYPES.has(normalized)) {
    return { ok: false, reason: "not_jpeg_png" };
  }
  const sniffed = sniffThumbnailType(input.head);
  if (sniffed === null) {
    return { ok: false, reason: "not_jpeg_png" };
  }
  if (normalized !== "" && normalized !== sniffed) {
    return { ok: false, reason: "type_mismatch" };
  }
  if (input.size <= 0 || input.size > THUMBNAIL_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, mimeType: sniffed };
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
 * `provider_unsupported`, `write_not_enabled`, `internal_error`) report
 * `"refused"`.
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
    case "outcome_unknown":
      return "outcome_unknown";
    default:
      return code !== null && code !== undefined && isDefinitiveRefusalCode(code)
        ? "refused"
        : "outcome_unknown";
  }
}
