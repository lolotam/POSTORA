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
 * Managed image intents use the leased RPC below. This legacy claim refuses them,
 * including an intent staged between its read and compare-and-set.
 *
 * Review follow-up F6: docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

export const FINAL_NOTIFIED_KEY = "final_notified_at";

export interface FinalNotificationClaim {
  claimed: boolean;
  /** Legacy marker read/write failure; distinct from a managed-intent refusal. */
  error: string | null;
  reason?: "managed_intent" | "legacy_candidate" | "ownership_unavailable" | "post_missing";
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
  const readOwnership = () => supabase
    .from("posts")
    .select("metadata, processing_started_at")
    .eq("id", postId)
    .maybeSingle();
  let ownership = await readOwnership();
  if (ownership.error) ownership = await readOwnership();
  const { data: row, error: readError } = ownership;
  if (readError) return { claimed: false, error: readError.message ?? String(readError), reason: "ownership_unavailable" };
  if (!row) return { claimed: false, error: null, reason: "post_missing" };

  const metadata = asRecord(row.metadata);
  if (metadata.final_notification_intent != null) {
    return { claimed: false, error: null, reason: "managed_intent" };
  }
  if (metadata.legacy_notification_candidate != null) {
    return { claimed: false, error: null, reason: "legacy_candidate" };
  }
  const marker = metadata[FINAL_NOTIFIED_KEY];
  if (markerCoversCycle(marker, row.processing_started_at ?? null)) return { claimed: false, error: null };

  // The UPDATE only matches while the marker is still what was read here.
  const path = `metadata->>${FINAL_NOTIFIED_KEY}`;
  const updatedMetadata: Record<string, unknown> = {
    ...metadata,
    [FINAL_NOTIFIED_KEY]: now.toISOString(),
  };
  const update = supabase
    .from("posts")
    .update({ metadata: updatedMetadata })
    .eq("id", postId)
    // Recheck under the UPDATE lock if an image finalizer staged an intent after our read.
    .is("metadata->final_notification_intent", null)
    .is("metadata->legacy_notification_candidate", null);
  const { data, error } = await (typeof marker === "string" ? update.eq(path, marker) : update.is(path, null)).select("id");
  if (error) return { claimed: false, error: error.message ?? String(error) };
  return { claimed: (data ?? []).length > 0, error: null };
}

export interface ThreadsImageNotificationClaim {
  claimed: boolean;
  claimId?: string;
  status?: string;
  authorizedPlatformPostIds?: string[];
  authorizedPlatformPostStatuses?: Record<string, string>;
  acknowledgedDeliveryKeys?: string[];
  error?: string | null;
}

export async function claimThreadsImageNotification(
  supabase: SupabaseClient,
  postId: string,
  expectedProcessingStartedAt: string,
  expectedStatus: string,
  expectedContent: Record<string, unknown>,
  lease = "3 minutes",
): Promise<ThreadsImageNotificationClaim> {
  const { data, error } = await supabase.rpc("claim_threads_image_notification", {
    p_post_id: postId,
    p_expected_processing_started_at: expectedProcessingStartedAt,
    p_expected_status: expectedStatus,
    p_expected_content: expectedContent,
    p_lease: lease,
  });
  if (error) return { claimed: false, error: error.message ?? String(error) };
  const res = data as { claimed?: boolean; claim_id?: string; status?: string; authorized_platform_post_ids?: string[]; authorized_platform_post_statuses?: Record<string, string>; delivery_acks?: Record<string, boolean>; error?: string } | null;
  return {
    claimed: res?.claimed === true && typeof res.claim_id === "string" && res.claim_id.length > 0,
    claimId: res?.claim_id,
    status: res?.status,
    authorizedPlatformPostIds: Array.isArray(res?.authorized_platform_post_ids) ? res.authorized_platform_post_ids : undefined,
    authorizedPlatformPostStatuses: res?.authorized_platform_post_statuses,
    acknowledgedDeliveryKeys: Object.entries(res?.delivery_acks ?? {}).filter(([, acknowledged]) => acknowledged === true).map(([key]) => key),
    error: res?.error ?? null,
  };
}

export async function confirmThreadsImageNotification(
  supabase: SupabaseClient,
  postId: string,
  expectedProcessingStartedAt: string,
  expectedStatus: string,
  expectedContent: Record<string, unknown>,
  claimId: string,
): Promise<{ confirmed: boolean; status?: string; error?: string | null }> {
  const { data, error } = await supabase.rpc("confirm_threads_image_notification", {
    p_post_id: postId,
    p_expected_processing_started_at: expectedProcessingStartedAt,
    p_expected_status: expectedStatus,
    p_expected_content: expectedContent,
    p_claim_id: claimId,
  });
  if (error) return { confirmed: false, error: error.message ?? String(error) };
  const res = data as { confirmed?: boolean; status?: string; error?: string } | null;
  return {
    confirmed: Boolean(res?.confirmed),
    status: res?.status,
    error: res?.error ?? null,
  };
}
