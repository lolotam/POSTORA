interface StoryPost {
  id: string;
  user_id: string;
  metadata?: {
    instagram_post_type?: string | string[] | null;
    instagram_share_to_story?: boolean;
  } | null;
}

/** Prepare the outbox before removing inline work. A failed write refuses the new producer. */
export async function prepareIndependentStory<T extends StoryPost>(
  post: T,
  accountId: string,
  prepare: (postId: string, accountId: string, userId: string) => Promise<boolean>,
): Promise<T> {
  const raw = post.metadata?.instagram_post_type;
  const types = Array.isArray(raw) ? raw : [raw ?? "feed"];
  if (!types.includes("reel") || (!types.includes("story") && post.metadata?.instagram_share_to_story !== true)) return post;
  if (!await prepare(post.id, accountId, post.user_id)) throw new Error("story_intent_not_recorded");
  return { ...post, metadata: { ...post.metadata, instagram_post_type: types.filter((type) => type !== "story"), instagram_share_to_story: false } };
}
