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
