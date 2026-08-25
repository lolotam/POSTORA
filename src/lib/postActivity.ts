interface PostActivityDates {
  created_at: string;
  scheduled_at?: string | null;
  posted_at?: string | null;
}

export function getPostActivityTimestamp(post: PostActivityDates): number {
  return Math.max(
    new Date(post.created_at).getTime(),
    post.scheduled_at ? new Date(post.scheduled_at).getTime() : 0,
    post.posted_at ? new Date(post.posted_at).getTime() : 0
  );
}
