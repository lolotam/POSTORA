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

type Settle = (supabase: unknown, args: {
  platformPostId: string | null;
  postId: string;
  socialAccountId: string | null;
  platform: string | null;
  status: "success" | "failed";
  providerPostId?: string | null;
  providerPostUrl?: string | null;
  responseData?: Record<string, unknown> | null;
}) => Promise<{ id: string | null; error: string | null }>;

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

/** Whether a platform_posts row for this story already exists, or why that could not be told. */
export type FindRecordedStory = (
  supabase: SupabaseClient,
  args: { postId: string; socialAccountId: string; storyId: string },
) => Promise<{ recorded: boolean; error: string | null }>;

/**
 * Looks for the story's row by post, account and the story's own media id. A failed read is an
 * error, never "not recorded": answering "none found" would write a second row for a story that
 * may already have one.
 */
export const findRecordedStory: FindRecordedStory = async (supabase, args) => {
  const { data, error } = await supabase
    .from("platform_posts")
    .select("id")
    .eq("post_id", args.postId)
    .eq("social_account_id", args.socialAccountId)
    .eq("platform_post_id", args.storyId)
    .limit(1);
  if (error) return { recorded: false, error: error.message ?? String(error) };
  return { recorded: (data ?? []).length > 0, error: null };
};

/**
 * Records the live story. Returns the error text on failure, for the caller to warn with.
 *
 * Idempotent: a retry, or a resumed or abandoned run carrying the same story, finds the row the
 * earlier attempt wrote and treats the story as recorded instead of inserting it again. Only the
 * reel's own pending row is ever updated, so the story's row is always an insert, and this check
 * is what keeps it to one.
 */
export async function recordPublishedStory(
  supabase: SupabaseClient,
  settle: Settle,
  args: {
    postId: string;
    account: { id: string; platform_username?: string | null; account_metadata?: unknown };
    story: { id: string; url: string };
  },
  find: FindRecordedStory = findRecordedStory,
): Promise<string | null> {
  try {
    const existing = await find(supabase, { postId: args.postId, socialAccountId: args.account.id, storyId: args.story.id });
    if (existing.error) return `could not check whether the story is already recorded: ${existing.error}`;
    if (existing.recorded) return null;
    const settled = await settle(supabase, {
      // A new row: only the reel ever resumes, and it settles its own pending row.
      platformPostId: null,
      postId: args.postId,
      socialAccountId: args.account.id,
      platform: "instagram",
      status: "success",
      providerPostId: args.story.id,
      providerPostUrl: args.story.url,
      responseData: {
        ig_post_subtype: "story",
        account_username: args.account.platform_username,
        account_metadata: args.account.account_metadata,
      },
    });
    return settled.error;
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
  settle: Settle,
  args: Parameters<typeof recordPublishedStory>[2],
  ledger: StoryLedger,
  sleep?: (ms: number) => Promise<void>,
): Promise<string | null> {
  const error = await recordWithOneRetry(() => recordPublishedStory(supabase, settle, args), sleep);
  ledger.live.push(args.story);
  if (!error) ledger.recorded.push(args.story);
  return error;
}
