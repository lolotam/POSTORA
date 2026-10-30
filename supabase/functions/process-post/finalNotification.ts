/**
 * An atomic claim on "tell the user this post is final", so it is told once.
 *
 * Two reconciler runs can settle the last two deferred rows of one post at the same moment,
 * and both then find the post terminal. Without a claim both would send the webhooks and the
 * failure email. The claim is a compare-and-set on `posts.metadata.final_notified_at`, the
 * same shape as claimPostForProcessing's compare-and-set on `scheduled_at`: the UPDATE
 * matches only while the marker still has the value this run read, and PostgreSQL re-checks
 * that predicate after waiting for the row lock, so exactly one of two simultaneous claims
 * gets a row back. No migration or RPC is needed.
 *
 * The marker is a timestamp, not a flag, so a post that is retried and becomes final again is
 * announced again: a marker older than the post's latest claim (`processing_started_at`)
 * belongs to an earlier cycle and is claimed over.
 *
 * Review follow-up F6: docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

export const FINAL_NOTIFIED_KEY = "final_notified_at";

export interface FinalNotificationClaim {
  claimed: boolean;
  /** Set when the claim could not be made at all; the caller sends anyway (see announce). */
  error: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whether a marker found on the post already covers its current processing cycle. */
export function markerCoversCycle(marker: unknown, processingStartedAt: string | null): boolean {
  if (typeof marker !== "string" || !marker) return false;
  if (!processingStartedAt) return true;
  const notified = Date.parse(marker);
  const started = Date.parse(processingStartedAt);
  if (Number.isNaN(notified) || Number.isNaN(started)) return true;
  return notified >= started;
}

export async function claimFinalNotification(
  supabase: SupabaseClient,
  postId: string,
  now = new Date(),
): Promise<FinalNotificationClaim> {
  const { data: row, error: readError } = await supabase
    .from("posts")
    .select("metadata, processing_started_at")
    .eq("id", postId)
    .maybeSingle();
  if (readError) return { claimed: false, error: readError.message ?? String(readError) };
  if (!row) return { claimed: false, error: "post not found" };

  const metadata = asRecord(row.metadata);
  const marker = metadata[FINAL_NOTIFIED_KEY];
  if (markerCoversCycle(marker, row.processing_started_at ?? null)) return { claimed: false, error: null };

  // The UPDATE only matches while the marker is still what was read here.
  const path = `metadata->>${FINAL_NOTIFIED_KEY}`;
  const update = supabase
    .from("posts")
    .update({ metadata: { ...metadata, [FINAL_NOTIFIED_KEY]: now.toISOString() } })
    .eq("id", postId);
  const { data, error } = await (typeof marker === "string" ? update.eq(path, marker) : update.is(path, null)).select("id");
  if (error) return { claimed: false, error: error.message ?? String(error) };
  return { claimed: (data ?? []).length > 0, error: null };
}
