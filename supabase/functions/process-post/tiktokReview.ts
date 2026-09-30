/**
 * Strict preflight for review-origin TikTok posts.
 *
 * Called from postToTikTok only when posts.metadata.tiktok_review_submission_id
 * is set. Legacy posts never enter this module. Throws before any init call.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { queryCreatorInfo } from "../_shared/tiktokContentPostingApi.ts";
import {
  buildTikTokPostInfo,
  tiktokPostSettingsFromReview,
  type TikTokPostInfo,
} from "../_shared/tiktokPostInfo.ts";
import {
  evaluateTikTokPublishPolicy,
  resolveReviewDurationSec,
} from "../_shared/tiktokPublishPolicy.ts";

export function tiktokReviewSubmissionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).tiktok_review_submission_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function prepareTikTokReviewPublish(input: {
  admin: SupabaseClient;
  accessToken: string;
  submissionId: string;
  post: {
    id: string;
    user_id: string;
    caption: string | null;
    media_file_ids: string[] | null;
    metadata: Record<string, unknown> | null;
  };
}): Promise<{ postInfo: TikTokPostInfo }> {
  const lookup = await queryCreatorInfo(fetch, input.accessToken, null, null);
  if (lookup.kind === "token_invalid") {
    throw new Error("TikTok session expired. Please reconnect your TikTok account.");
  }
  if (lookup.kind === "blocked") {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:POSTING_BLOCKED");
  }
  if (lookup.kind === "unavailable") {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE");
  }

  const { data: submission, error: submissionError } = await input.admin
    .from("tiktok_review_submissions")
    .select("snapshot")
    .eq("id", input.submissionId)
    .eq("post_id", input.post.id)
    .eq("user_id", input.post.user_id)
    .maybeSingle();
  if (submissionError) {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED");
  }
  if (!submission) {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND");
  }

  const snapshot = isRecord(submission.snapshot) ? submission.snapshot : null;
  const caption = snapshot?.caption;
  const mediaFileId = typeof snapshot?.media_file_id === "string" ? snapshot.media_file_id : null;
  if (
    typeof caption !== "string" || input.post.caption !== caption ||
    (input.post.media_file_ids?.[0] ?? null) !== mediaFileId
  ) {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH");
  }
  const settings = tiktokPostSettingsFromReview(snapshot?.settings);
  if (!settings) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_REQUIRED");
  let mediaMetadata: unknown = null;
  if (typeof mediaFileId === "string" && mediaFileId.length > 0) {
    const { data: media, error: mediaError } = await input.admin
      .from("media_files")
      .select("metadata")
      .eq("id", mediaFileId)
      .eq("user_id", input.post.user_id)
      .maybeSingle();
    if (mediaError) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:MEDIA_READ_FAILED");
    mediaMetadata = media?.metadata;
  }

  const durationSec = resolveReviewDurationSec(mediaMetadata, snapshot?.media_duration_sec);
  const violations = evaluateTikTokPublishPolicy({
    caption,
    settings,
    mediaFileId: typeof mediaFileId === "string" && mediaFileId.length > 0 ? mediaFileId : null,
    durationSec,
    creator: lookup.capabilities,
  });
  if (violations.length > 0) {
    throw new Error(
      `TIKTOK_REVIEW_NEEDS_ATTENTION:${violations.map((violation) => violation.code).join(",")}`,
    );
  }

  const { data: claimed, error: claimError } = await input.admin
    .from("tiktok_review_submissions")
    .update({ dispatch_state: "publishing" })
    .eq("id", input.submissionId)
    .eq("post_id", input.post.id)
    .eq("user_id", input.post.user_id)
    .in("dispatch_state", ["dispatching", "scheduled"])
    .is("provider_publish_id", null)
    .select("id");
  if (claimError) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED");
  if (!claimed?.length) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:ALREADY_DISPATCHED");

  return { postInfo: buildTikTokPostInfo(caption, settings) };
}

export async function recordReviewPublishId(
  admin: SupabaseClient,
  input: { submissionId: string; postId: string; userId: string; publishId: string },
): Promise<void> {
  const { error } = await admin.from("tiktok_review_submissions")
    .update({ provider_publish_id: input.publishId })
    .eq("id", input.submissionId)
    .eq("post_id", input.postId)
    .eq("user_id", input.userId)
    .eq("dispatch_state", "publishing")
    .is("provider_publish_id", null);
  if (error) throw new Error("tiktok_review_publish_id_record_failed");
}
