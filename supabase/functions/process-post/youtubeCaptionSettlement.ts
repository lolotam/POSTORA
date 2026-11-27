/**
 * Pure settlement scrubbing for upload-time YouTube captions (`D-P7-5`).
 *
 * When a post reaches any terminal settlement (`completed`, `partial`,
 * `failed`), `youtube_caption.content` is removed from `posts.metadata`
 * leaving `{ language, name, format }`.
 */

export function scrubSettledYoutubeCaptionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }
  const rawCaption = metadata.youtube_caption;
  if (
    !rawCaption ||
    typeof rawCaption !== "object" ||
    Array.isArray(rawCaption) ||
    !("content" in rawCaption)
  ) {
    return metadata;
  }

  const captionRecord = rawCaption as Record<string, unknown>;
  const scrubbedCaption: Record<string, unknown> = {};
  if (typeof captionRecord.language === "string") {
    scrubbedCaption.language = captionRecord.language;
  }
  if (typeof captionRecord.name === "string") {
    scrubbedCaption.name = captionRecord.name;
  }
  if (typeof captionRecord.format === "string") {
    scrubbedCaption.format = captionRecord.format;
  }

  return {
    ...metadata,
    youtube_caption: scrubbedCaption,
  };
}

export function hasUnscrubbedYoutubeCaptionContent(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const rawCaption = metadata.youtube_caption;
  return Boolean(
    rawCaption &&
      typeof rawCaption === "object" &&
      !Array.isArray(rawCaption) &&
      "content" in rawCaption,
  );
}

export interface SettledPostCaptionDbPort {
  readPostRow(postId: string): Promise<{
    data: { status?: unknown; metadata?: unknown } | null;
    error: unknown;
  }>;
  updatePostMetadata(
    postId: string,
    metadata: Record<string, unknown>,
  ): Promise<{ error: unknown }>;
}

/**
 * Returns true only when the post has reached a terminal status (`completed`,
 * `partial`, `failed`), still carries `youtube_caption.content`, and has no
 * unconsumed `legacy_notification_candidate` or unnotified
 * `final_notification_intent` whose `content_hash` fence depends on the
 * pre-settlement `metadata` snapshot.
 */
export function canScrubSettledPostCaptionNow(
  row: { status?: unknown; metadata?: unknown } | null | undefined,
): boolean {
  if (!row || typeof row !== "object") return false;
  const status = row.status;
  if (status !== "completed" && status !== "partial" && status !== "failed") {
    return false;
  }
  const metadata = row.metadata as Record<string, unknown> | null | undefined;
  if (!hasUnscrubbedYoutubeCaptionContent(metadata)) {
    return false;
  }
  const candidate = metadata?.legacy_notification_candidate;
  if (
    candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).consumed !== true
  ) {
    return false;
  }
  const intent = metadata?.final_notification_intent;
  if (
    intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    (intent as Record<string, unknown>).notified !== true
  ) {
    return false;
  }
  return true;
}

/**
 * Reads the live `status, metadata` row from `public.posts` and scrubs
 * `youtube_caption.content` only when the post is terminal and all notification
 * content-hash fences have been consumed. Never writes a stale in-memory
 * `post.metadata` snapshot back to the database.
 */
export async function scrubSettledPostCaptionInDb(
  port: SettledPostCaptionDbPort,
  postId: string,
): Promise<boolean> {
  try {
    const { data, error } = await port.readPostRow(postId);
    if (error || !canScrubSettledPostCaptionNow(data)) {
      return false;
    }
    const currentMetadata = data!.metadata as Record<string, unknown>;
    const scrubbed = scrubSettledYoutubeCaptionMetadata(currentMetadata);
    if (!scrubbed || scrubbed === currentMetadata) {
      return false;
    }
    const { error: updateError } = await port.updatePostMetadata(postId, scrubbed);
    return !updateError;
  } catch {
    return false;
  }
}
