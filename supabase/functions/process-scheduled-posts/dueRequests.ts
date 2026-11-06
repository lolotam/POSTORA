interface DuePost {
  id: string;
  scheduled_at: string | null;
  publish_requested_at: string | null;
}

type DueExpectation = { kind: "scheduled"; value: string } | { kind: "requested"; value: string };

/** Each query excludes null stamps; keep the scheduled snapshot when both queries see a post. */
export function mergeDuePosts<S extends DuePost, R extends DuePost>(
  scheduled: S[],
  requested: R[],
): Array<{ post: S | R; expectation: DueExpectation }> {
  const seen = new Set<string>();
  const due: Array<{ post: S | R; expectation: DueExpectation }> = [];
  for (const [kind, posts] of [["scheduled", scheduled], ["requested", requested]] as const) {
    for (const post of posts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      const value = kind === "scheduled" ? post.scheduled_at! : post.publish_requested_at!;
      due.push({ post, expectation: { kind, value } });
    }
  }
  return due;
}
