/**
 * The retry guard: a retried post is not published to Instagram again when it is already live.
 *
 * A publish that went unanswered can still go live, and some of those runs end as a failed row
 * (an image or carousel cannot be deferred to the reconciler). The user's next move is Retry,
 * which creates a new container and posts the same thing twice. So a retry first looks for the
 * post on the account. Spec: docs/superpowers/specs/2026-10-30-ig-publish-timeout-design.md,
 * step 4.
 */

import { captionMatches, type MediaSummary } from "./instagramPublish.ts";

/** A post's statuses once a run has finished it: only these runs are retries. */
const FINISHED_STATUSES = new Set(["failed", "completed"]);

/** How far before the post was created (or scheduled for) its media may have been published. */
export const RETRY_LOOKBACK_MS = 10 * 60 * 1000;

export const ALREADY_LIVE_MESSAGE =
  "This post was already live on Instagram, so it was recorded instead of being posted again.";

export function alreadyLiveCopiesMessage(count: number): string {
  return `This post is already live on Instagram ${count} times, so it was not posted again. Check the account for duplicates.`;
}

/** What a retry knows from the rows earlier runs recorded for this account. */
export interface RetryState {
  /** The story already has its own success row: a retry does not post it again. */
  storyRecorded: boolean;
  /** This post's feed post or reel already has a success row for the account: it is done. */
  feedRecorded?: boolean;
  /**
   * Which of these media ids a row already records for the account (another post's media), or
   * null when that could not be read.
   */
  recordedMediaIds?: (ids: string[]) => Promise<Set<string> | null>;
}

export const NOT_A_RETRY: RetryState = { storyRecorded: false };

/**
 * The `media_type` Graph lists for what this post publishes as its feed post or reel. Only images
 * become a carousel: a video post publishes its first file as a single reel.
 */
export function expectedMediaType(mediaType: "IMAGE" | "VIDEO" | string, mediaCount: number): string {
  return mediaType === "IMAGE" && mediaCount > 1 ? "CAROUSEL_ALBUM" : mediaType;
}

/**
 * The account's media as Graph listed them, or null when any entry is malformed: an entry that is
 * not an object with a string id and media type cannot be trusted to stop a publish.
 */
export function parseMediaList(data: unknown): MediaSummary[] | null {
  if (data === undefined) return [];
  if (!Array.isArray(data)) return null;
  const wellFormed = data.every((item) =>
    item !== null && typeof item === "object" &&
    typeof (item as MediaSummary).id === "string" && (item as MediaSummary).id !== "" &&
    typeof (item as MediaSummary).media_type === "string"
  );
  return wellFormed ? data as MediaSummary[] : null;
}

export type RetryGuardDecision =
  | { kind: "publish" }
  | { kind: "already_live"; media: MediaSummary }
  | { kind: "already_live_copies"; count: number };

/**
 * Whether this run retries a post an earlier run finished: its status when the run began is a
 * finished one. A first run is never one, so an unrelated post with the same caption can never
 * stop it. A resumed run is not one either: it finishes its own container.
 */
export function isRetryRun(entryStatus: string | null | undefined, resume: boolean): boolean {
  return !resume && FINISHED_STATUSES.has(entryStatus ?? "");
}

/** The earliest the post can have gone live: when it was created or scheduled for, less the lookback. */
export function retryWindowStart(post: { created_at?: string | null; scheduled_at?: string | null }): number {
  const times = [post.created_at, post.scheduled_at].map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  return (times.length ? Math.max(...times) : 0) - RETRY_LOOKBACK_MS;
}

/**
 * The account's media that can be this post: its caption, published since `notBeforeMs`, of the
 * same media type, and not already recorded as another post's media. Caption alone is not
 * enough: a duplicated post shares it, and is recorded on its own row.
 */
export function candidateMedia(
  media: MediaSummary[],
  post: { caption: string | null | undefined; notBeforeMs: number; mediaType: string },
  recordedIds: Set<string>,
): MediaSummary[] {
  return captionMatches(media, post.caption, post.notBeforeMs)
    .filter((item) => item.media_type === post.mediaType)
    .filter((item) => !recordedIds.has(item.id));
}

/** What a retry does, given the media that can be this post. */
export function retryGuardDecision(matches: MediaSummary[]): RetryGuardDecision {
  if (matches.length === 1) return { kind: "already_live", media: matches[0] };
  if (matches.length > 1) return { kind: "already_live_copies", count: matches.length };
  return { kind: "publish" };
}

/** A success row of this post for the account, as the retry reads it. */
export interface RecordedRow {
  story_subtype: string | null;
  story_on_reel: string | null;
  carried_story: unknown;
}

/**
 * What this post's success rows already record for the account: its story, its feed post or reel.
 * A row that carries a live story it could not record (`unrecorded_story`) still proves the story
 * is live, so a later retry must not post it again.
 */
export function recordedOnRetryRows(rows: RecordedRow[]): { story: boolean; feed: boolean } {
  const isStory = (row: RecordedRow) => row.story_subtype === "story" || row.story_on_reel === "true";
  const carriesStory = (row: RecordedRow) => row.carried_story !== null && row.carried_story !== undefined;
  return { story: rows.some((row) => isStory(row) || carriesStory(row)), feed: rows.some((row) => !isStory(row)) };
}
