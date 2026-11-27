/**
 * Public view of a YouTube settlement's evidence and public API guards for
 * upload-time YouTube captions.
 *
 * The REST and MCP surfaces proxy this shape, so it is the single allowlist
 * between a stored platform_posts row and a caller. Nothing else in
 * response_data is exposed: it can contain credentialed URLs or provider
 * bodies. A row without evidence stays without evidence — a disconnected
 * account cannot be presented as if its follow-ups had been observed.
 */

import {
  CAPTION_CONTENT_MAX_BYTES,
  CAPTION_LANGUAGE_PATTERN,
  type CaptionFormat,
} from "../_shared/captionFile.ts";

export interface PublicYoutubeCaptionEvidence {
  state: string;
  reason: string | null;
  language?: string;
  format?: CaptionFormat;
  byte_length?: number;
}

export interface PublicYoutubeEvidence {
  requested_privacy: string;
  effective_privacy: string;
  thumbnail: { state: string; reason: string | null };
  first_comment: { state: string; reason: string | null };
  playlist: { state: string; reason: string | null };
  caption: PublicYoutubeCaptionEvidence;
}

const PRIVACY = ["public", "unlisted", "private"];
const STATES = ["not_requested", "applied", "skipped", "failed", "unknown"];
const REASONS = [
  "no_time",
  "authority_lost",
  "refused",
  "download_failed",
  "answer_lost",
  "not_owned",
  "quota_budget",
  "invalid_caption",
  "missing_scope",
  "rate_limited",
  "conflict",
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function followUp(input: unknown): { state: string; reason: string | null } {
  const item = isPlainRecord(input) ? input : {};
  const state = typeof item.state === "string" && STATES.includes(item.state) ? item.state : "unknown";
  const reason = typeof item.reason === "string" && REASONS.includes(item.reason) ? item.reason : null;
  return { state, reason };
}

function captionFollowUp(input: unknown): PublicYoutubeCaptionEvidence {
  const base = followUp(input);
  const item = isPlainRecord(input) ? input : {};
  const language =
    typeof item.language === "string" && CAPTION_LANGUAGE_PATTERN.test(item.language)
      ? item.language
      : undefined;
  const format: CaptionFormat | undefined =
    item.format === "srt" || item.format === "vtt" ? item.format : undefined;
  const byteLength =
    typeof item.byte_length === "number" &&
    Number.isInteger(item.byte_length) &&
    item.byte_length >= 0 &&
    item.byte_length <= CAPTION_CONTENT_MAX_BYTES
      ? item.byte_length
      : undefined;

  return {
    ...base,
    ...(language !== undefined ? { language } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(byteLength !== undefined ? { byte_length: byteLength } : {}),
  };
}

/** Allowlist the evidence fields; never echo the raw stored object or caption content. */
export function sanitizedYoutubeEvidence(value: unknown): PublicYoutubeEvidence {
  const record = isPlainRecord(value) ? value : {};
  const privacy = (key: string, fallback: string) =>
    typeof record[key] === "string" && PRIVACY.includes(record[key] as string)
      ? (record[key] as string)
      : fallback;
  return {
    requested_privacy: privacy("requested_privacy", "private"),
    effective_privacy: privacy("effective_privacy", "unknown"),
    thumbnail: followUp(record.thumbnail),
    first_comment: followUp(record.first_comment),
    playlist: record.playlist ? followUp(record.playlist) : { state: "not_requested", reason: null },
    caption: record.caption ? captionFollowUp(record.caption) : { state: "not_requested", reason: null },
  };
}

/** One destination's view. Other destinations on the same post are untouched. */
export function youtubeEvidenceOf(
  responseData: unknown,
  platform: unknown,
): PublicYoutubeEvidence | undefined {
  if (platform !== "youtube") return undefined;
  const record = isPlainRecord(responseData) ? responseData : {};
  return record.youtube_publish_evidence
    ? sanitizedYoutubeEvidence(record.youtube_publish_evidence)
    : undefined;
}

/**
 * Returns true when an incoming n8n API request attempts to pass `youtube_caption`
 * either at the top level or inside a nested `metadata` object (Spec §14.3, OD-9).
 */
export function hasDisallowedYoutubeCaptionInput(body: unknown): boolean {
  if (!isPlainRecord(body)) return false;
  if ("youtube_caption" in body && body.youtube_caption !== undefined) {
    return true;
  }
  if (isPlainRecord(body.metadata)) {
    if ("youtube_caption" in body.metadata && body.metadata.youtube_caption !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Strips `youtube_caption.content` from a post `metadata` object while preserving
 * `{ language, name, format }` (Spec §14.3, D-P7-5).
 */
export function stripYoutubeCaptionFromMetadata<T>(metadata: T): T {
  if (!isPlainRecord(metadata)) return metadata;

  let changed = false;
  const copy: Record<string, unknown> = { ...metadata };

  if (isPlainRecord(copy.youtube_caption) && "content" in copy.youtube_caption) {
    const { content: _content, ...restCaption } = copy.youtube_caption;
    copy.youtube_caption = restCaption;
    changed = true;
  }

  if (isPlainRecord(copy.legacy_notification_candidate)) {
    const candidate = copy.legacy_notification_candidate;
    if (isPlainRecord(candidate.content_fence) && isPlainRecord(candidate.content_fence.metadata)) {
      const fenceMetadata = candidate.content_fence.metadata;
      if (isPlainRecord(fenceMetadata.youtube_caption) && "content" in fenceMetadata.youtube_caption) {
        const { content: _content, ...restNestedCaption } = fenceMetadata.youtube_caption;
        copy.legacy_notification_candidate = {
          ...candidate,
          content_fence: {
            ...candidate.content_fence,
            metadata: {
              ...fenceMetadata,
              youtube_caption: restNestedCaption,
            },
          },
        };
        changed = true;
      }
    }
  }

  return changed ? (copy as T) : metadata;
}

/**
 * Sanitizes a post row before returning it from `n8n-api` so `youtube_caption.content`
 * is never exposed on read.
 */
export function sanitizePostForPublicRead<T>(post: T): T {
  if (!isPlainRecord(post)) return post;
  let changed = false;
  const copy: Record<string, unknown> = { ...post };

  if ("metadata" in copy && isPlainRecord(copy.metadata)) {
    const strippedMetadata = stripYoutubeCaptionFromMetadata(copy.metadata);
    if (strippedMetadata !== copy.metadata) {
      copy.metadata = strippedMetadata;
      changed = true;
    }
  }

  if ("youtube_caption" in copy && isPlainRecord(copy.youtube_caption) && "content" in copy.youtube_caption) {
    const { content: _content, ...restCaption } = copy.youtube_caption;
    copy.youtube_caption = restCaption;
    changed = true;
  }

  if (Array.isArray(copy.platform_posts)) {
    let platformPostsChanged = false;
    const sanitizedPlatformPosts = copy.platform_posts.map((entry: unknown) => {
      if (!isPlainRecord(entry) || !isPlainRecord(entry.response_data)) {
        return entry;
      }
      const responseData = entry.response_data;
      if (!("youtube_publish_evidence" in responseData) || !responseData.youtube_publish_evidence) {
        return entry;
      }
      platformPostsChanged = true;
      return {
        ...entry,
        response_data: {
          ...responseData,
          youtube_publish_evidence: sanitizedYoutubeEvidence(responseData.youtube_publish_evidence),
        },
      };
    });
    if (platformPostsChanged) {
      copy.platform_posts = sanitizedPlatformPosts;
      changed = true;
    }
  }

  return (changed ? copy : post) as T;
}
