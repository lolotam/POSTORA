/* eslint-disable @typescript-eslint/no-explicit-any */
// Turns one inbound public comment into a durable audience row. Called off the response path
// by every comment ingest after the own-comment check; a failure is logged and dropped because
// the comment itself is already recorded in social_inbox_events.

export interface SocialContactTouch {
  // Every platform whose comments reach social_inbox_events. Kept as a union rather than
  // widened to string so a new platform has to be added to the table's CHECK too.
  platform: "facebook" | "instagram" | "threads" | "youtube";
  author: { id: string | null; name: string | null; username: string | null };
  comment: { id: string; text: string };
  post: { id: string | null };
}

export type SocialContactTouchOutcome = "upserted" | "no_identity" | "failed";

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function touchSocialContact(
  admin: any,
  socialAccountId: string,
  touch: SocialContactTouch,
): Promise<SocialContactTouchOutcome> {
  const id = clean(touch.author.id);
  const username = clean(touch.author.username);
  if (!id && !username) return "no_identity";

  const { data, error } = await admin.rpc("touch_social_contact", {
    p_social_account_id: socialAccountId,
    p_platform: touch.platform,
    p_author_id: id,
    p_author_name: clean(touch.author.name),
    p_author_username: username,
    p_comment_text: touch.comment.text,
    p_post_id: touch.post.id,
  });
  if (error) {
    // Comment text is deliberately absent from this line.
    console.error(`[social-contacts] touch failed for ${touch.platform} comment ${touch.comment.id} on account ${socialAccountId}: ${error.message}`);
    return "failed";
  }
  return data ? "upserted" : "no_identity";
}
