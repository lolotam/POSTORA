/**
 * Strict preflight for review-origin TikTok posts.
 *
 * Called from postToTikTok only when posts.metadata.tiktok_review_submission_id
 * is set. Legacy posts never enter this module. Throws before any init call.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import {
  buildTikTokPostInfo,
  tiktokPostSettingsFromMetadata,
  type TikTokPostInfo,
} from "../_shared/tiktokPostInfo.ts";
import {
  creatorCapabilitiesFromTikTok,
  evaluateTikTokPublishPolicy,
} from "../_shared/tiktokPublishPolicy.ts";

const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const CREATOR_INFO_TIMEOUT_MS = 10_000;

const POSTING_BLOCKED_CODES = new Set([
  "spam_risk_too_many_posts",
  "spam_risk_user_banned_from_posting",
  "reached_active_user_cap",
  "user_posting_banned",
]);

export function tiktokReviewSubmissionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).tiktok_review_submission_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function reviewCaption(metadata: Record<string, unknown> | null, caption: string | null): string {
  const title = metadata?.tiktok_title;
  if (typeof title === "string") return title;
  return caption ?? "";
}

async function fetchCreatorInfo(accessToken: string): Promise<unknown> {
  try {
    const response = await fetchWithTimeout(
      CREATOR_INFO_URL,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      CREATOR_INFO_TIMEOUT_MS,
    );
    return await response.json();
  } catch {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE");
  }
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
  const creatorBody = await fetchCreatorInfo(input.accessToken);
  if (!isRecord(creatorBody)) {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE");
  }
  const errorCode = isRecord(creatorBody.error) && typeof creatorBody.error.code === "string"
    ? creatorBody.error.code
    : null;
  if (errorCode && errorCode !== "ok") {
    if (errorCode === "access_token_invalid") {
      throw new Error("TikTok session expired. Please reconnect your TikTok account.");
    }
    if (POSTING_BLOCKED_CODES.has(errorCode)) {
      throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:POSTING_BLOCKED");
    }
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE");
  }

  const creator = creatorCapabilitiesFromTikTok(creatorBody.data);
  if (!creator) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE");

  const metadata = input.post.metadata;
  const settings = tiktokPostSettingsFromMetadata(metadata ?? {});
  if (!settings) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_REQUIRED");

  const { data: submission, error: submissionError } = await input.admin
    .from("tiktok_review_submissions")
    .select("snapshot")
    .eq("id", input.submissionId)
    .eq("post_id", input.post.id)
    .eq("user_id", input.post.user_id)
    .maybeSingle();
  if (submissionError || !submission) {
    throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND");
  }

  const snapshot = isRecord(submission.snapshot) ? submission.snapshot : null;
  let durationSec = positiveDuration(snapshot?.media_duration_sec);

  const mediaFileId = input.post.media_file_ids?.[0] ?? null;
  if (typeof mediaFileId === "string" && mediaFileId.length > 0) {
    const { data: media, error: mediaError } = await input.admin
      .from("media_files")
      .select("metadata")
      .eq("id", mediaFileId)
      .eq("user_id", input.post.user_id)
      .maybeSingle();
    if (mediaError) throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:MEDIA_READ_FAILED");
    const mediaMetadata = media && isRecord(media.metadata) ? media.metadata : null;
    const mediaDuration = positiveDuration(mediaMetadata?.duration);
    if (mediaDuration !== null) durationSec = mediaDuration;
  }

  const caption = reviewCaption(metadata, input.post.caption);
  const violations = evaluateTikTokPublishPolicy({
    caption,
    settings,
    mediaFileId: typeof mediaFileId === "string" && mediaFileId.length > 0 ? mediaFileId : null,
    durationSec,
    creator,
  });
  if (violations.length > 0) {
    throw new Error(
      `TIKTOK_REVIEW_NEEDS_ATTENTION:${violations.map((violation) => violation.code).join(",")}`,
    );
  }

  return { postInfo: buildTikTokPostInfo(caption, settings) };
}
