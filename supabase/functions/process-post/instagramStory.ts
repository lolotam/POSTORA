/**
 * A published Instagram story gets its own platform_posts row, written before the reel.
 *
 * With Facebook login the story is published first and the reel after. If the reel then
 * defers (Meta still processing), the handler throws and the story's result used to be lost:
 * a resumed run skips the story, so nothing ever recorded it, and a later give-up on the reel
 * failed the whole account while the story was live. The Business-login path already writes
 * the story row itself; this does the same for Facebook login.
 *
 * Review follow-up F9: docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

/** A published story: its media id and link. */
export interface StoryRef {
  id: string;
  url: string;
}

/** The key under which a story that could not be recorded travels on the reel's pending row. */
export const UNRECORDED_STORY_KEY = "unrecorded_story";

/** The story a pending row carries because recording it failed, or null. */
export function readUnrecordedStory(responseData: unknown): StoryRef | null {
  const story = (responseData as Record<string, unknown> | null)?.[UNRECORDED_STORY_KEY] as Partial<StoryRef> | null | undefined;
  return story && typeof story.id === "string" && story.id && typeof story.url === "string" ? { id: story.id, url: story.url } : null;
}

/**
 * The pending row's data once its carried story has been recorded (pass `ledger.recorded`): without it, so a further
 * resume does not record the same story twice. Untouched if that story was not recorded.
 */
export function dropRecordedStory(responseData: Record<string, unknown> | null, recorded: StoryRef[]): Record<string, unknown> | null {
  const carried = readUnrecordedStory(responseData);
  if (!responseData || !carried || !recorded.some((story) => story.id === carried.id)) return responseData;
  const { [UNRECORDED_STORY_KEY]: _recorded, ...rest } = responseData;
  return rest;
}

/** What the roll-up and the notifications see for live stories: successful Instagram results. */
export function recordedStoryResults(stories: StoryRef[]): { platform: string; status: string; platform_post_url: string }[] {
  return stories.map((story) => ({ platform: "instagram", status: "success", platform_post_url: story.url }));
}

const RETRY_DELAY_MS = 500;

/** Runs `record` and, if it answers an error, once more. Returns the last error, or null. */
export async function recordWithOneRetry(
  record: () => Promise<string | null>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | null> {
  const first = await record();
  if (!first) return null;
  await sleep(RETRY_DELAY_MS);
  return await record();
}

/**
 * Records the live story. Returns the error text on failure, for the caller to warn with.
 *
 * Idempotent and atomic: record_published_story looks for the story's row and inserts it in one
 * database call, under a unique index on (post, account, story media id). A retry, or a resumed
 * or abandoned run carrying the same story, gets the existing row back instead of a second one,
 * even when two of them race. Only the reel's own pending row is ever updated, so the story's
 * row is always an insert.
 */
export async function recordPublishedStory(
  supabase: SupabaseClient,
  args: {
    postId: string;
    account: { id: string; platform_username?: string | null; account_metadata?: unknown };
    story: StoryRef;
  },
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("record_published_story", {
      p_post_id: args.postId,
      p_social_account_id: args.account.id,
      p_story_id: args.story.id,
      p_story_url: args.story.url,
      p_response_data: {
        account_username: args.account.platform_username,
        account_metadata: args.account.account_metadata,
      },
    });
    if (error) return error.message ?? String(error);
    // Success means a row now shows the story; an answer without one must not let the carry go.
    return (data as { platform_post_id?: string | null } | null)?.platform_post_id ? null : "record_published_story answered no row";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The stories one account's run published: all of them live, and the ones whose row was written. */
export interface StoryLedger {
  /** Published on Instagram, whether or not their row was written: they count in the roll-up. */
  live: StoryRef[];
  /** Live stories whose row is in the database: only these may leave a pending row's carry. */
  recorded: StoryRef[];
}

export function newStoryLedger(): StoryLedger {
  return { live: [], recorded: [] };
}

/**
 * Records a live story, retrying once, and notes it in the ledger. The story is live on
 * Instagram whether or not its row was written, so it always goes in `live` for the roll-up: a
 * reel that then fails outright after a failed story write must not leave the post `failed`
 * with a story out there. It goes in `recorded` only when the row landed, because that list
 * decides which carried stories may be forgotten. Returns the error if the write still failed
 * after the retry, for the warning and for carrying the story to a later run.
 */
export async function recordLiveStory(
  supabase: SupabaseClient,
  args: Parameters<typeof recordPublishedStory>[1],
  ledger: StoryLedger,
  sleep?: (ms: number) => Promise<void>,
): Promise<string | null> {
  const error = await recordWithOneRetry(() => recordPublishedStory(supabase, args), sleep);
  ledger.live.push(args.story);
  if (!error) ledger.recorded.push(args.story);
  return error;
}

/**
 * Records the story a pending reel row carries, for a run that is about to settle that row.
 * Nothing carried is a success with nothing recorded. A story that still cannot be recorded
 * (after the retry) is an error the caller must not settle the reel over: the row keeps its
 * carry and the reconciler tries again, which recording's idempotence makes safe.
 */
export async function recordCarriedStory(
  supabase: SupabaseClient,
  args: {
    postId: string;
    socialAccountId: string;
    rowData: Record<string, unknown> | null;
  },
  sleep?: (ms: number) => Promise<void>,
): Promise<{ recorded: StoryRef[]; error: string | null }> {
  const story = readUnrecordedStory(args.rowData);
  if (!story) return { recorded: [], error: null };
  const error = await recordWithOneRetry(() =>
    recordPublishedStory(supabase, {
      postId: args.postId,
      account: {
        id: args.socialAccountId,
        platform_username: args.rowData?.account_username as string | null | undefined,
        account_metadata: args.rowData?.account_metadata,
      },
      story,
    }), sleep);
  return error ? { recorded: [], error } : { recorded: [story], error: null };
}

/**
 * The data a reel's pending row keeps when it is settled as the account's live story: the
 * deferral and the carry are finished with, the account details stay, and a marker says why
 * the row shows a story.
 */
export function storyOnReelRowData(responseData: unknown): Record<string, unknown> {
  const data = responseData && typeof responseData === "object" ? responseData as Record<string, unknown> : {};
  const { deferred: _deferred, [UNRECORDED_STORY_KEY]: _carried, ...rest } = data;
  return { ...rest, story_recorded_on_reel_row: true };
}
