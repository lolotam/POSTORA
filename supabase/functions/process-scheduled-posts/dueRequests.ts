interface DuePost {
  id: string;
  scheduled_at: string | null;
  publish_requested_at: string | null;
}

type DueExpectation = { kind: "scheduled"; value: string } | { kind: "requested"; value: string };

/**
 * Each query excludes null stamps. When both queries see a post, its request wins: a failed
 * kick then leaves the request queued instead of marking the post failed, which matters for a
 * retry whose failed results the request already cleared.
 */
export function mergeDuePosts<S extends DuePost, R extends DuePost>(
  scheduled: S[],
  requested: R[],
): Array<{ post: S | R; expectation: DueExpectation }> {
  const requestedById = new Map(requested.map((post) => [post.id, post]));
  const seen = new Set<string>();
  const due: Array<{ post: S | R; expectation: DueExpectation }> = [];
  for (const candidate of [...scheduled, ...requested]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const request = requestedById.get(candidate.id);
    due.push(request
      ? { post: request, expectation: { kind: "requested", value: request.publish_requested_at! } }
      : { post: candidate, expectation: { kind: "scheduled", value: candidate.scheduled_at! } });
  }
  return due;
}
