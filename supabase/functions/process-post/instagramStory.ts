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
 * The pending row's data once its carried story has been recorded: without it, so a further
 * resume does not record the same story twice. Untouched if that story was not recorded.
 */
export function dropRecordedStory(responseData: Record<string, unknown> | null, recorded: StoryRef[]): Record<string, unknown> | null {
  const carried = readUnrecordedStory(responseData);
  if (!responseData || !carried || !recorded.some((story) => story.id === carried.id)) return responseData;
  const { [UNRECORDED_STORY_KEY]: _recorded, ...rest } = responseData;
  return rest;
}

/** What the roll-up and the notifications see for stories this run recorded: live and successful. */
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

/** Records the live story. Returns the error text on failure, for the caller to warn with. */
export async function recordPublishedStory(
  supabase: unknown,
  settle: Settle,
  args: {
    postId: string;
    account: { id: string; platform_username?: string | null; account_metadata?: unknown };
    story: { id: string; url: string };
  },
): Promise<string | null> {
  try {
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

/**
 * Records a live story, retrying once, and notes it in `live` when it landed so the run's
 * roll-up counts it: a reel that then fails outright must not leave the post `failed` while a
 * story is live. Returns the error if it still failed after the retry.
 */
export async function recordLiveStory(
  supabase: unknown,
  settle: Settle,
  args: Parameters<typeof recordPublishedStory>[2],
  live: StoryRef[],
  sleep?: (ms: number) => Promise<void>,
): Promise<string | null> {
  const error = await recordWithOneRetry(() => recordPublishedStory(supabase, settle, args), sleep);
  if (!error) live.push(args.story);
  return error;
}
