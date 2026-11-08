interface PublicationResult {
  id?: string;
  platform: string;
  social_account_id?: string | null;
  status: string | null;
  response_data?: Record<string, unknown> | null;
}

/** Preserve the distinction between an account's Reel and its separate Story. */
export function instagramPublicationType(result: PublicationResult): string | null {
  if (result.platform !== "instagram") return null;
  const subtype = result.response_data?.ig_post_subtype;
  return typeof subtype === "string" && ["story", "reel", "feed", "carousel"].includes(subtype) ? subtype : null;
}

/** A successful subtype must not conceal another subtype that failed or is pending. */
export function publicationSummary(results: readonly PublicationResult[]): "partialFailure" | "partialPending" | null {
  const outcomes = new Map<string, string | null>();
  const rank: Record<string, number> = { success: 3, pending: 2, pending_inbox: 2, failed: 1 };
  results.forEach((result, index) => {
    const account = result.social_account_id ?? result.id ?? String(index);
    const key = `${result.platform}:${account}:${instagramPublicationType(result) ?? "post"}`;
    const previous = outcomes.get(key);
    if (!outcomes.has(key) || (rank[result.status ?? ""] ?? 0) > (rank[previous ?? ""] ?? 0)) outcomes.set(key, result.status);
  });
  const statuses = [...outcomes.values()];
  if (!statuses.includes("success")) return null;
  if (statuses.some((status) => status === "pending" || status === "pending_inbox")) return "partialPending";
  return statuses.includes("failed") ? "partialFailure" : null;
}
