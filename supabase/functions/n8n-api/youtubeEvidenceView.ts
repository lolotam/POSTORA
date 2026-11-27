/**
 * Public view of a YouTube settlement's evidence.
 *
 * The REST and MCP surfaces proxy this shape, so it is the single allowlist
 * between a stored platform_posts row and a caller. Nothing else in
 * response_data is exposed: it can contain credentialed URLs or provider
 * bodies. A row without evidence stays without evidence — a disconnected
 * account cannot be presented as if its follow-ups had been observed.
 */

export interface PublicYoutubeEvidence {
  requested_privacy: string;
  effective_privacy: string;
  thumbnail: { state: string; reason: string | null };
  first_comment: { state: string; reason: string | null };
  playlist: { state: string; reason: string | null };
}

const PRIVACY = ["public", "unlisted", "private"];
const STATES = ["not_requested", "applied", "skipped", "failed", "unknown"];
const REASONS = [
  "no_time",
  "authority_lost",
  "refused",
  "download_failed",
  "answer_lost",
  "not_owned",
  "quota_budget",
];

function followUp(input: unknown): { state: string; reason: string | null } {
  const item = (input ?? {}) as Record<string, unknown>;
  const state = typeof item.state === "string" && STATES.includes(item.state) ? item.state : "unknown";
  const reason = typeof item.reason === "string" && REASONS.includes(item.reason) ? item.reason : null;
  return { state, reason };
}

/** Allowlist the evidence fields; never echo the raw stored object. */
export function sanitizedYoutubeEvidence(value: unknown): PublicYoutubeEvidence {
  const record = (value ?? {}) as Record<string, unknown>;
  const privacy = (key: string, fallback: string) =>
    typeof record[key] === "string" && PRIVACY.includes(record[key] as string)
      ? (record[key] as string)
      : fallback;
  return {
    requested_privacy: privacy("requested_privacy", "private"),
    effective_privacy: privacy("effective_privacy", "unknown"),
    thumbnail: followUp(record.thumbnail),
    first_comment: followUp(record.first_comment),
    playlist: record.playlist ? followUp(record.playlist) : { state: "not_requested", reason: null },
  };
}

/** One destination's view. Other destinations on the same post are untouched. */
export function youtubeEvidenceOf(
  responseData: unknown,
  platform: unknown,
): PublicYoutubeEvidence | undefined {
  if (platform !== "youtube") return undefined;
  const record = (responseData ?? {}) as Record<string, unknown>;
  return record.youtube_publish_evidence
    ? sanitizedYoutubeEvidence(record.youtube_publish_evidence)
    : undefined;
}
