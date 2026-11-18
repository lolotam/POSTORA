import { checkpointThreadsImage, publishThreadsContainer, threadsParentContainer, ThreadsCheckpointUnavailable, ThreadsCheckpointCanceled, type ThreadsImageCheckpoint } from "./threadsPublish.ts";
import { buildYoutubeUploadRequest, buildYoutubeUploadUrl } from "./youtubePublisher.ts";
import { hashRequest } from "../_shared/partnerApiIdempotency.ts";
/**
 * ============================================================================
 * PROCESS-POST EDGE FUNCTION
 * ============================================================================
 * 
 * This function processes posts and publishes content to multiple social media
 * platforms. Provider-specific additions belong in imported adapters so this
 * legacy coordinator can continue shrinking.
 * 
 * TABLE OF CONTENTS
 * ═════════════════
 * 
 * SECTION 1: IMPORTS & CONFIGURATION .......................... Line ~45
 *   - Supabase client import
 *   - EdgeRuntime declaration
 *   - CORS headers
 *   - Environment variables
 * 
 * SECTION 2: TYPE DEFINITIONS ................................. Line ~75
 *   - PostData interface (with all platform metadata)
 *   - SocialAccount interface
 *   - MediaFile interface
 *   - PlatformResult type
 * 
 * SECTION 3: SHARED HELPER FUNCTIONS .......................... Line ~220
 *   3.1 Response Helpers
 *       - createJsonResponse()
 *       - createErrorResponse()
 *   3.2 Media Helpers
 *       - downloadMediaAsBlob()
 *       - downloadMediaAsArrayBuffer()
 *   3.3 Polling Helpers
 *       - pollWithRetry()
 *   3.4 Webhook Helpers
 *       - sendWebhookNotifications()
 *   3.5 Background Task Helpers
 *       - pollTikTokPublishStatus()
 * 
 * SECTION 4: MAIN REQUEST HANDLER ............................. Line ~450
 *   - CORS preflight handling
 *   - Post retrieval and validation
 *   - Media URL generation
 *   - Platform dispatch loop
 *   - Result aggregation and response
 * 
 * SECTION 5: PLATFORM HANDLERS (Alphabetical) ................. Line ~750
 *   5.1  Bluesky ............................................ Line ~760
 *        - postToBluesky()
 *        - parseBlueskyFacets()
 *   5.2  Facebook ........................................... Line ~950
 *        - postToFacebook()
 *        - postFacebookReel()
 *        - extractFacebookPostId()
 *   5.3  Instagram .......................................... Line ~1200
 *        - postToInstagram()
 *        - pollContainerStatus()
 *        - publishInstagramMedia()
 *   5.4  LinkedIn ........................................... Line ~1550
 *        - postToLinkedIn()
 *   5.5  Pinterest .......................................... Line ~1750
 *        - postToPinterest()
 *   5.6  Reddit ............................................. Line ~1950
 *        - postToReddit()
 *   5.7  Threads ............................................ Line ~2100
 *        - postToThreads()
 *   5.8  TikTok ............................................. Line ~2300
 *        - postToTikTok()
 *   5.9  Twitter/X .......................................... Line ~2750
 *        - postToTwitter()
 *        - splitIntoTweets()
 *        - addThreadNumbers()
 *   5.10 YouTube ............................................ Line ~3250
 *        - postToYouTube()
 * 
 * ============================================================================
 */

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: IMPORTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

// Import shared utilities from _shared folder
// NOTE: These modules are now extracted to reduce file size and improve maintainability
// See: supabase/functions/_shared/platforms/ for reusable platform utilities
import type { PlatformMetadata as SharedPlatformMetadata } from "../_shared/platforms/types.ts";
import { graphId, type GraphResponse } from "./graphResponse.ts";
import {
  ALREADY_LIVE_MESSAGE,
  alreadyLiveCopiesMessage,
  candidateMedia,
  expectedMediaType,
  parseMediaList,
  isRetryRun,
  NOT_A_RETRY,
  type RecordedRow,
  recordedOnRetryRows,
  type RetryGuardDecision,
  type RetryState,
  retryGuardDecision,
  retryWindowStart,
} from "./instagramRetryGuard.ts";
import {
  matchPublishedMedia,
  type MediaSummary,
  publishContainer,
  resolveInstagramShareToFeed,
  PUBLISHED_LOOKBACK_MS,
  PUBLISHED_SEARCH_LIMIT,
} from "./instagramPublish.ts";
import { validateRequestBody, validationErrorResponse } from "../_shared/validate.ts";
import { postWebhook, validateWebhookTarget } from "../_shared/webhookSecurity.ts";
import { getMissingMediaFileIds, orderPostMediaFiles } from "../_shared/post-media.ts";
import { claimPostForProcessing } from "../_shared/postProcessingClaim.ts";
import { activeRetryRequest } from "../_shared/publishRequest.ts";
import { mediaSendability } from "../_shared/partnerMediaStore.ts";
import { prepareIndependentStory } from "./independentStory.ts";
import { selectedLinkedInDestinationIds } from "../_shared/linkedinDestinations.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import { composioClientFromEnv } from "../_shared/composioClient.ts";
import { publishYouTubeViaComposio } from "./youtubeComposio.ts";
import { prepareTikTokReviewPublish, recordReviewPublishId, requiredReviewSubmissionId } from "./tiktokReview.ts";
import { firstPublicPostId } from "../_shared/tiktokPublishOutcome.ts";
import { CHECK_ONCE_DEADLINE, classifyContainerStatus, CONTAINER_STATUS_FIELDS, type ContainerState, containerFailureMessage, pollContainer } from "../_shared/metaContainerStatus.ts";
import {
  abandonReason,
  accountTiming,
  bufferAfterFinishedMs,
  type ContainerWait,
  ContainerStillProcessing,
  claimFollowUps,
  deferrableDeadline,
  type DeferredKind,
  deferralGiveUpMessage,
  giveUpMessage,
  hasUnresolvedThreadsPublish,
  newDeferral,
  threadsMediaType,
  withFollowUpsStarted,
  withUnresolvedThreadsPublish,
  workerPublishDeadline,
  NO_DEFERRAL,
  followUpTimeoutMs,
  ownContainerDeadline,
  refuseOnSpentWorker,
  storyRecoveryExhausted,
  pollDeadline,
  readDeferral,
  recordStillProcessing,
  type PublishTiming,
  type ResumeContext,
  unfinishedError,
} from "./deferredPublish.ts";
import { createCarouselChildren, threadsChildWait, waitForCarouselChildren } from "./carouselChildren.ts";
import { claimFinalNotification, claimThreadsImageNotification, confirmThreadsImageNotification } from "./finalNotification.ts";
import {
  runResumableVideoUpload,
  type ResumableUploadOutcome,
} from "./youtubeResumableUpload.ts";
import {
  createVideoByteSource,
  fetchApprovedMedia,
  readBoundedBytes,
} from "./youtubeVideoSource.ts";
import { publicSupabaseUrl } from "../_shared/publicSupabaseUrl.ts";
import { createOwnedVideoSource } from "./youtubeUploadSource.ts";
import {
  createSupabaseYoutubeUploadSessionStore,
  type YoutubeUploadRefusal,
} from "./youtubeUploadSession.ts";
import {
  approvedMediaHosts,
  isApprovedMediaUrl,
  redactProviderText,
  YOUTUBE_UPLOAD_REASON,
  youtubeUploadPublicMessage,
  youtubeStorageReadUrl,
} from "./youtubeUploadPolicy.ts";
import {
  continueYoutubeUpload,
  type ContinuationResult,
  type YoutubeContinuationPorts,
} from "./youtubeUploadContinuation.ts";
import {
  uploadOwnedFailure,
  uploadRefusalFailure,
  youtubeUploadFailureResponseData,
  youtubeUploadOutcomeMessage,
  youtubeUploadOutcomeReason,
  youtubeUploadUnconfirmedMessage,
} from "./youtubeUploadOutcome.ts";
import {
  runYoutubeFollowUps,
  type YoutubeFollowUpDeps,
} from "./youtubeUploadFollowUps.ts";
import { refreshYoutubeAccessToken } from "./youtubeTokenRefresh.ts";
import {
  dropRecordedStory,
  readUnrecordedStory,
  recordCarriedStory,
  newStoryLedger,
  recordedStoryResults,
  recordLiveStory,
  storyOnReelRowData,
  type StoryRef,
  UNRECORDED_STORY_KEY,
} from "./instagramStory.ts";
import {
  buildWebhookResults,
  type PlatformResultSummary,
  type PostReader,
  readPostOutcome,
  unreadableOutcomeLog,
  storyRecordedOnReelRowLog,
  liveReelUnrecordedStoryLog,
  unrecordedStoryLog,
  writeLogRow,
} from "./postSettlement.ts";
import {
  cdnReadPreferenceOrder,
  loadMediaProviderRows,
  resolveMediaUrl,
  type MediaFile as MediaFileRow,
} from "./mediaDelivery.ts";
import { z } from "npm:zod@3.23.8";

/** When this worker started: the runtime reuses it for several requests inside one lifetime. */
const WORKER_STARTED_AT_MS = Date.now();

const ProcessPostSchema = z.object({
  post_id: z.string().min(1).max(100),
  platforms: z.array(z.string().max(50)).optional(),
  account_ids: z.array(z.string().max(100)).optional(),
  // Sent by process-scheduled-posts: the scheduled_at it selected. The
  // processing claim honours it (see _shared/postProcessingClaim.ts), so a
  // post unscheduled after selection is declined rather than published.
  expected_scheduled_at: z.string().max(64).nullable().optional(),
  expected_publish_requested_at: z.string().max(64).optional(),
  // Sent by reconcile-deferred-publishes (service role only): finish the pending row
  // a Meta container was deferred on, instead of publishing the post afresh.
  resume_platform_post_id: z.string().uuid().optional(),
  // Sent by reconcile-deferred-publishes (service role only): notification recovery only mode
  notification_only: z.boolean().optional(),
  attempt_started_at: z.string().max(64).optional(),
  candidate_id: z.string().uuid().optional(),
  notification_claim_id: z.string().uuid().optional(),
  // Sent by reconcile-deferred-publishes (service role only): carry on a YouTube
  // upload that a worker left half written.
  //
  // The session URI is NOT part of the dispatch. It stays in the private
  // session table and is read with the claim token, so the credential never
  // travels in a request body and never appears in a response.
  resume_youtube_upload_session_id: z.string().uuid().optional(),
  resume_youtube_upload_lease_token: z.string().uuid().optional(),
}).passthrough();

/**
 * EdgeRuntime provides background task capabilities via waitUntil()
 * This allows us to start long-running tasks (like TikTok polling)
 * without blocking the HTTP response.
 */
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
} | undefined;

/**
 * CORS headers - required for browser-based API calls
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Supabase configuration from environment
 */
/**
 * Settle one platform_posts row through the Phase 7.4 seam, with a
 * TRANSITIONAL fallback for the deploy-before-migrate window.
 *
 * Merging auto-deploys this function while migrations are applied by hand, so
 * there is a window in which the code calls partner_settle_platform_post and
 * the function does not exist yet. Without a fallback that window is not
 * "logs an error": at the per-account result site a successful provider
 * publish throws, lands in the catch, whose own settle also fails, and the
 * post is marked failed with NO platform_posts row at all -- a published post
 * recorded as a failure, which is the exact inversion the send path's
 * bookkeeping rules forbid.
 *
 * So a missing function degrades to the legacy write instead. It loses the
 * enqueue, which costs nothing in this phase: post.published and post.failed
 * are uncertified (Phase 8.4), so no subscription can exist to receive one.
 *
 * REMOVE THIS once 20260902140000 is applied everywhere -- it is the second
 * writer 7.4 exists to eliminate, kept only for the window.
 */
// deno-lint-ignore no-explicit-any
async function settlePlatformPost(supabase: any, args: {
  platformPostId: string | null;
  postId: string;
  socialAccountId: string | null;
  platform: string | null;
  status: "success" | "failed";
  providerPostId?: string | null;
  providerPostUrl?: string | null;
  errorMessage?: string | null;
  responseData?: Record<string, unknown> | null;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc("partner_settle_platform_post", {
    p_platform_post_id: args.platformPostId,
    p_post_id: args.postId,
    p_social_account_id: args.socialAccountId,
    p_platform: args.platform,
    p_status: args.status,
    p_provider_post_id: args.providerPostId ?? null,
    p_provider_post_url: args.providerPostUrl ?? null,
    p_error_message: args.errorMessage ?? null,
    p_response_data: args.responseData ?? null,
  });

  if (!error) {
    return { id: (data as { platform_post_id?: string } | null)?.platform_post_id ?? null, error: null };
  }

  // PGRST202 is PostgREST's "no function matches"; the message form covers a
  // stale schema cache, which is the same window wearing a different hat.
  const missing = error.code === "PGRST202" ||
    String(error.message ?? "").includes("Could not find the function");
  if (!missing) return { id: null, error: error.message };

  console.error(
    "[publish-seam] partner_settle_platform_post is missing -- falling back to the legacy write. " +
      "Apply migration 20260902140000 and run NOTIFY pgrst, 'reload schema'.",
  );

  if (args.platformPostId) {
    const { error: updateError } = await supabase.from("platform_posts").update({
      status: args.status,
      platform_post_id: args.providerPostId ?? undefined,
      platform_post_url: args.providerPostUrl ?? undefined,
      error_message: args.errorMessage ?? undefined,
      // As the RPC does: data given replaces the row's, none keeps it.
      response_data: args.responseData ?? undefined,
      posted_at: args.status === "success" ? new Date().toISOString() : undefined,
    }).eq("id", args.platformPostId);
    return { id: args.platformPostId, error: updateError?.message ?? null };
  }

  const { data: row, error: insertError } = await supabase.from("platform_posts").insert({
    post_id: args.postId,
    social_account_id: args.socialAccountId,
    platform: args.platform,
    platform_post_id: args.providerPostId ?? null,
    platform_post_url: args.providerPostUrl ?? null,
    status: args.status,
    error_message: args.errorMessage ?? null,
    response_data: args.responseData ?? null,
    posted_at: args.status === "success" ? new Date().toISOString() : null,
  }).select("id").single();
  return { id: row?.id ?? null, error: insertError?.message ?? null };
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Platform-specific metadata stored in posts.metadata
 * Each platform has its own settings that control how content is published
 */
interface PlatformMetadata
  extends Pick<SharedPlatformMetadata, "threads_first_comment" | "threads_location_skipped_reason"> {
  // Account selection
  selected_account_ids?: string[] | null;

  // Webhook configuration (per-request)
  webhook_url?: string;
  webhook_secret?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // BLUESKY
  // ─────────────────────────────────────────────────────────────────────────
  bluesky_alt_text?: string | null;
  bluesky_language?: string | null;
  bluesky_embed_link?: string | null;
  bluesky_content_warning?: "sexual" | "nudity" | "porn" | "graphic-media" | "gore" | null;
  bluesky_adult_content?: boolean;
  bluesky_reply_control?: "everyone" | "following" | "mentioned" | null;
  bluesky_reply_settings?: {
    selectedOption: "anyone" | "nobody" | "following" | "mentioned" | "list";
    selectedListUri: string | null;
  } | null;

  // ─────────────────────────────────────────────────────────────────────────
  // FACEBOOK
  // ─────────────────────────────────────────────────────────────────────────
  facebook_post_type?: ("feed" | "story" | "reel")[] | "feed" | "story" | "reel" | null;
  
  facebook_location?: string | null;
  facebook_location_id?: string | null;
  facebook_first_comment?: string | null;
  facebook_link?: string | null;
  facebook_share_to_story?: boolean;
  facebook_reel_description?: string | null;
  facebook_tags?: string | null;
  facebook_reel_collaborator?: string | null;

  // ─────────────────────────────────────────────────────────────────────────
  // INSTAGRAM
  // ─────────────────────────────────────────────────────────────────────────
  instagram_post_type?: ("feed" | "story" | "reel")[] | "feed" | "story" | "reel" | null;
  instagram_location?: string | null;
  instagram_first_comment?: string | null;
  instagram_collaborator?: string | null;
  instagram_share_to_feed?: boolean;
  instagram_cover_thumbnail_offset?: number | null;
  instagram_audio_name?: string | null;
  instagram_location_id?: string | null;
  instagram_alt_text?: string | null;
  instagram_hide_like_counts?: boolean;
  instagram_disable_comments?: boolean;
  instagram_share_to_story?: boolean;
  // ─────────────────────────────────────────────────────────────────────────
  // LINKEDIN
  // ─────────────────────────────────────────────────────────────────────────
  linkedin_visibility?: "public" | "connections" | null;
  linkedin_first_comment?: string | null;
  linkedin_article_link?: string | null;
  /** Multi-destination publish. "personal" + organization page IDs. */
  linkedin_destination_ids?: string[] | null;
  /** Account-scoped LinkedIn destinations selected by n8n. */
  linkedin_destinations?: Array<{ account_id: string; destination_id: string }> | null;
  /** @deprecated single-page legacy field; superseded by linkedin_destination_ids */
  linkedin_page_id?: string | null;

  // ─────────────────────────────────────────────────────────────────────────
  // PINTEREST
  // ─────────────────────────────────────────────────────────────────────────
  pinterest_board_id?: string | null;
  pinterest_title?: string | null;
  pinterest_link?: string | null;
  pinterest_alt_text?: string | null;
  pinterest_note?: string | null;

  // ─────────────────────────────────────────────────────────────────────────
  // REDDIT
  // ─────────────────────────────────────────────────────────────────────────
  reddit_subreddit?: string | null;
  reddit_title?: string | null;
  reddit_post_type?: "self" | "link" | "image" | null;
  reddit_link_url?: string | null;
  reddit_spoiler?: boolean;
  reddit_nsfw?: boolean;
  reddit_send_replies?: boolean;
  reddit_flair?: string | null;

  // ─────────────────────────────────────────────────────────────────────────
  // THREADS
  // ─────────────────────────────────────────────────────────────────────────
  threads_reply_control?: "everyone" | "following" | "mentioned" | null;
  threads_hide_from_feed?: boolean;
  threads_alt_text?: string | null;
  threads_location_id?: string | null;
  threads_cross_share_to_ig?: boolean;
  threads_cross_share_to_ig_dark_mode?: boolean;

  // ─────────────────────────────────────────────────────────────────────────
  // TIKTOK
  // ─────────────────────────────────────────────────────────────────────────
  tiktok_privacy_level?: "SELF_ONLY" | "FOLLOWER_OF_CREATOR" | "MUTUAL_FOLLOW_FRIENDS" | "PUBLIC_TO_EVERYONE" | null;
  tiktok_allow_comment?: boolean;
  tiktok_allow_duet?: boolean;
  tiktok_allow_stitch?: boolean;
  tiktok_disclose_content?: boolean;
  tiktok_your_brand?: boolean;
  tiktok_branded_content?: boolean;
  tiktok_ai_generated?: boolean;
  tiktok_title?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // TWITTER/X
  // ─────────────────────────────────────────────────────────────────────────
  twitter_thread_mode?: boolean;
  twitter_post_as_long_tweet?: boolean;
  twitter_custom_title?: string | null;
  twitter_reply_settings?: "everyone" | "following" | "mentionedUsers" | "subscribers" | "verified" | null;
  twitter_for_super_followers_only?: boolean;
  twitter_share_with_followers?: boolean;
  twitter_reply_to_tweet_id?: string | null;
  twitter_quote_tweet_url?: string | null;
  twitter_tagged_user_ids?: string[] | null;
  twitter_exclude_reply_user_ids?: string[] | null;
  twitter_place_id?: string | null;
  twitter_community_id?: string | null;
  twitter_dm_deep_link?: string | null;
  twitter_nullcast?: boolean;
  twitter_thumbnail_url?: string | null;
  twitter_poll_enabled?: boolean;
  twitter_poll_options?: string[] | null;
  twitter_poll_duration?: number | null;

  // ─────────────────────────────────────────────────────────────────────────
  // YOUTUBE
  // ─────────────────────────────────────────────────────────────────────────
  youtube_video_type?: "video" | "short" | null;
  youtube_title?: string | null;
  youtube_description?: string | null;
  youtube_visibility?: "public" | "unlisted" | "private" | null;
  youtube_tags?: string[] | null;
  youtube_category?: string | null;
  youtube_made_for_kids?: boolean;
  youtube_allow_embedding?: boolean;
  youtube_public_stats_viewable?: boolean;
  youtube_contains_synthetic_media?: boolean;
  youtube_has_paid_promotion?: boolean;
  youtube_notify_subscribers?: boolean;
  youtube_video_language?: string | null;
  youtube_audio_language?: string | null;
  youtube_recording_date?: string | null;
  youtube_license?: "youtube" | "creativeCommon" | null;
  youtube_allowed_countries?: string[] | null;
  youtube_blocked_countries?: string[] | null;
  youtube_first_comment?: string | null;
  youtube_thumbnail_url?: string | null;
}

/**
 * Post data from the posts table
 */
interface PostData {
  id: string;
  user_id: string;
  caption: string | null;
  platforms: string[];
  media_file_ids: string[] | null;
  scheduled_at?: string | null;
  publish_requested_at?: string | null;
  metadata?: PlatformMetadata | null;
  source?: string | null;
  /** As read when this run began, before it claimed the post. */
  status?: string | null;
  processing_started_at?: string | null;
  created_at?: string | null;
}

export function normalizeThreadsInternalMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const normalized = { ...(metadata ?? {}) };
  delete normalized.pinterest_post_type;
  delete normalized.final_notified_at;
  delete normalized.settlement_rollup_at;
  delete normalized.settlement_rollup_status;
  delete normalized.settlement_rollup_processing_started_at;
  delete normalized.attempt_target_account_ids;
  delete normalized.attempt_retained_account_ids;
  delete normalized.attempt_retained_platform_post_ids;
  delete normalized.attempt_started_at;
  delete normalized.attempt_scope;
  delete normalized.final_notification_intent;
  delete normalized.legacy_notification_candidate;
  return normalized;
}

/**
 * Social account data from social_accounts table
 */
export function threadsImageContentFence(post: PostData): Record<string, unknown> {
  // Sibling publishers may add History-only output metadata after admission.
  return {
    user_id: post.user_id,
    caption: post.caption,
    media_file_ids: post.media_file_ids,
    metadata: normalizeThreadsInternalMetadata(post.metadata as Record<string, unknown> | null | undefined),
    platforms: post.platforms,
    scheduled_at: post.scheduled_at ?? null,
    publish_requested_at: post.publish_requested_at ?? null,
    source: post.source ?? null,
  };
}

interface SocialAccount {
  id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  access_token: string;
  refresh_token: string | null;
  account_metadata: Record<string, unknown> | null;
  ig_auth_type?: string | null;
  auth_provider?: "native" | "composio";
  connection_id?: string | null;
  workspace_id?: string | null;
}

function threadsImageExecutionCallbacks(
  supabase: SupabaseClient,
  post: PostData,
  execution: ResumeContext,
  initialResponseData: Record<string, unknown>,
  onResponseData: (responseData: Record<string, unknown>) => void,
): Pick<ResumeContext, "markPublishStarted" | "releasePublishUnsent"> {
  let responseData = initialResponseData;
  const update = (deferral: ResumeContext["deferral"]) => {
    execution.deferral = deferral;
    responseData = { ...responseData, deferred: deferral };
    onResponseData(responseData);
  };
  return {
    markPublishStarted: async () => {
      const current = execution.deferral;
      if (!current.execution_id || !current.execution_claimed_until) {
        return { error: "missing Threads image execution owner" };
      }
      if (current.publish_attempt_id) return { claimed: false };
      const { data: marked, error: markError } = await supabase.rpc("mark_threads_image_publish_started", {
        p_platform_post_id: execution.platformPostId,
        p_expected_claimed_until: current.execution_claimed_until,
        p_execution_id: current.execution_id,
        p_expected_content: threadsImageContentFence(post),
      });
      if (markError) return { error: markError.message };
      if (marked !== true) return { claimed: false };
      update({ ...current, publish_attempt_id: current.execution_id });
      return { claimed: true };
    },
    releasePublishUnsent: async () => {
      const current = execution.deferral;
      if (!current.execution_id || !current.execution_claimed_until || !current.attempt_started_at ||
        !current.publish_attempt_id) {
        throw new ThreadsCheckpointUnavailable("Threads image unsent-marker identity is incomplete");
      }
      const { data: released, error: releaseError } = await supabase.rpc("release_threads_image_publish_unsent", {
        p_platform_post_id: execution.platformPostId,
        p_expected_container_id: current.container_id,
        p_expected_processing_started_at: current.attempt_started_at,
        p_expected_claimed_until: current.execution_claimed_until,
        p_execution_id: current.execution_id,
        p_publish_attempt_id: current.publish_attempt_id,
        p_expected_content: threadsImageContentFence(post),
      });
      if (releaseError) {
        throw new ThreadsCheckpointUnavailable("Threads image unsent-marker release acknowledgement was lost");
      }
      if (released !== true) return false;
      const next = { ...current };
      delete next.publish_attempt_id;
      update(next);
      return true;
    },
  };
}

/**
 * Media file data from media_files table.
 *
 * It lives in mediaDelivery.ts because the publishing path and the YouTube
 * continuation have to resolve a file the same way.
 */
type MediaFile = MediaFileRow;

/**
 * Result from posting to a platform
 */
interface PlatformPostResult {
  id?: string;
  url?: string;
  /** A newly created image already has its stable pending row; the outer loop must not settle or insert it. */
  deferredHandoff?: { platformPostId: string; responseData: Record<string, unknown> };
  /**
   * The pending row the handler wrote for this account.
   *
   * The outer loop settles THAT row instead of writing a new one, so a
   * YouTube upload that started before its row was settled does not end up
   * with two rows.
   */
  pendingPlatformPostId?: string;
  /**
   * The handler settled its own public row.
   *
   * The YouTube upload settles its row through the fenced settlement, because
   * only the worker that still owns the upload may record the outcome. The
   * outer loop must not settle it a second time.
   */
  settledByUpload?: boolean;
  /**
   * The work continues in a later worker.
   *
   * The row stays pending and the post stays processing, so the sweeper
   * leaves it alone and the continuation finishes it.
   */
  pendingContinuation?: boolean;
  /** The platform's public post id when it differs from `id`. TikTok's `id` is the publish_id
   *  that webhooks are matched on, so the post id it reports on completion travels here. */
  providerPostId?: string;
  publicationSubtype?: "reel";
  /** When true, the platform handler has already written its own platform_posts rows
   *  (one or more) and the outer loop must skip the default insert. */
  selfWroteRows?: boolean;
  /** Per-subtype results when a single platform fans out to multiple rows (e.g. IG story+reel) */
  subResults?: Array<{
    subtype: string;
    status: "success" | "failed";
    id?: string;
    url?: string;
    error?: string;
  }>;
  /** Optional warnings to surface in response_data.warnings[] */
  warnings?: string[];
  /** Optional sanitized debug object surfaced in response_data.location_debug */
  location_debug?: Record<string, unknown>;
  /** Optional Threads-only topic tag debug surfaced in response_data.topic_tag_debug */
  topic_tag_debug?: Record<string, unknown>;
  /** Optional structured payload merged into platform_posts.response_data (e.g. LinkedIn destination fan-out) */
  response_data?: Record<string, unknown>;
  /** Threads only: what happened to the requested cross-share to Instagram. */
  cross_share?: {
    requested: boolean;
    attempted: boolean;
    capability_at_publish: unknown;
    dark_mode: boolean;
    status: unknown;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: SHARED HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// 3.1 Response Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Create a JSON response with CORS headers
 */
function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Create an error response with CORS headers
 */
function createErrorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 3.1.0.1 Location Tagging Helpers (FB pre-check, post-publish verify, logs)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget structured log for location tagging events.
 * Never logs tokens, full URLs containing tokens, or auth headers.
 * All errors are swallowed — logging must never break publishing.
 */
async function logLocationEvent(args: {
  userId?: string | null;
  errorCode: string;
  level?: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Direct insert, matching the other two system_logs writes in this file.
    // This called the log_system_event RPC, which named four columns
    // system_logs has never had; every call raised, and the catch below hid it
    // for months. That is why the insert error is now surfaced.
    const { error } = await supabase.from("system_logs").insert({
      level: args.level || "warn",
      category: "post",
      source: "process-post",
      message: args.message,
      user_id: args.userId ?? null,
      metadata: { error_code: args.errorCode, ...(args.details ?? {}) },
    });
    if (error) console.error("logLocationEvent insert failed:", error.message);
  } catch (_e) {
    // swallow — logging must never break publishing
  }
}

/**
 * Truncate a Meta error message to 300 chars and strip token-like substrings.
 */
function safeMetaErrorMessage(msg: unknown): string | null {
  if (typeof msg !== "string") return null;
  return msg.replace(/access_token=[^&\s"']+/gi, "access_token=***").slice(0, 300);
}

/**
 * Decide whether a Meta error is location-related → eligible for retry-without-location.
 */
function isFbLocationError(metaError: { message?: string; code?: number; error_subcode?: number } | undefined): boolean {
  if (!metaError) return false;
  const msg = (metaError.message || "").toLowerCase();
  const subcode = metaError.error_subcode;
  if (subcode === 1366046 || subcode === 1487205 || subcode === 460) return true;
  return msg.includes("place") || msg.includes("location") || msg.includes("not a valid place");
}

function isIgLocationError(metaError: { message?: string; code?: number; error_subcode?: number } | undefined): boolean {
  if (!metaError) return false;
  const msg = (metaError.message || "").toLowerCase();
  return msg.includes("location_id") || msg.includes("location") || msg.includes("not a valid location");
}

/**
 * Sanitize a Meta error object for safe debug exposure. Strips tokens, headers,
 * and any nested sensitive fields. Keeps only { code, subcode, type, message }.
 */
function redactMetaError(
  err: unknown,
): { code: number | null; subcode: number | null; type: string | null; message: string | null } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: number; error_subcode?: number; type?: string; message?: string };
  return {
    code: typeof e.code === "number" ? e.code : null,
    subcode: typeof e.error_subcode === "number" ? e.error_subcode : null,
    type: typeof e.type === "string" ? e.type : null,
    message: safeMetaErrorMessage(e.message),
  };
}

/**
 * Best-effort GET with a short hard timeout. Returns parsed JSON or `null` on any failure.
 * Used for non-critical post-publish location verification — must NEVER throw.
 */
async function fetchJsonWithTimeout(url: string, timeoutMs = 4000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json().catch(() => null);
      return data;
    } finally {
      clearTimeout(t);
    }
  } catch (_e) {
    return null;
  }
}

/**
 * Pre-publish eligibility check for a Facebook `place` Page ID.
 * Returns `eligible: true` on transient errors so the post still attempts to publish —
 * the post-publish verify step will surface silent drops as a warning.
 */
async function checkFacebookPlaceEligibility(
  placeId: string,
  pageAccessToken: string,
): Promise<{ eligible: boolean; name?: string; reason?: string }> {
  if (!placeId || placeId.startsWith("osm_")) {
    return { eligible: false, reason: "osm_or_missing" };
  }
  try {
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(placeId)}?fields=id,name,location,category,category_list,verification_status,is_eligible_for_location_tag&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (data?.error) {
      // Treat API errors as inconclusive — don't block, let publish + verify decide.
      return { eligible: true, reason: "check_failed" };
    }
    const name: string | undefined = data?.name;
    const loc = data?.location;
    const hasCoords = !!(loc && (loc.latitude !== undefined || loc.longitude !== undefined));
    const eligibleFlag = data?.is_eligible_for_location_tag === true;
    const cats: string[] = [
      ...(Array.isArray(data?.category_list) ? data.category_list.map((c: { name?: string }) => c?.name || "") : []),
      typeof data?.category === "string" ? data.category : "",
    ].filter(Boolean).map((s) => s.toLowerCase());
    const placeLikeCategoryHit = cats.some((c) =>
      /(restaurant|hotel|cafe|store|shop|landmark|park|airport|stadium|museum|venue|attraction|tourist|local business|food|bar|gym|school|hospital|church|mosque)/i.test(c)
    );
    const eligible = eligibleFlag || hasCoords || placeLikeCategoryHit;
    return {
      eligible,
      name,
      reason: eligible ? undefined : (eligibleFlag === false ? "not_eligible_flag" : (hasCoords ? undefined : "no_coordinates_no_place_category")),
    };
  } catch (_e) {
    return { eligible: true, reason: "check_failed" };
  }
}

/**
 * Post-publish verification: did Meta actually attach the `place` to the published FB post?
 * Returns true when `place` is present, false when missing, null on lookup errors.
 */
async function verifyFacebookPlaceAttached(
  postId: string,
  pageAccessToken: string,
): Promise<boolean | null> {
  try {
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(postId)}?fields=id,permalink_url,place&access_token=${encodeURIComponent(pageAccessToken)}`;
    // Short timeout (2.5s) so post-publish verification never delays publishing meaningfully.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    const data = await res.json().catch(() => ({}));
    if (data?.error) return null;
    const place = data?.place;
    return !!(place && (place.id || place.name));
  } catch (_e) {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3.1.1 Bluesky DPoP Helpers (for OAuth accounts)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Base64 URL encode a buffer (for DPoP JWT encoding)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Import a private key from JWK for DPoP signing
 */
async function importBlueskyPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

/**
 * Generate a DPoP proof JWT for Bluesky OAuth
 */
async function generateBlueskyDPoPProof(
  privateKey: CryptoKey,
  publicKeyJWK: JsonWebKey,
  method: string,
  url: string,
  accessToken?: string,
  nonce?: string
): Promise<string> {
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: {
      kty: publicKeyJWK.kty,
      crv: publicKeyJWK.crv,
      x: publicKeyJWK.x,
      y: publicKeyJWK.y,
    },
  };

  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };

  // Include server-provided nonce for DPoP nonce binding (RFC 9449)
  if (nonce) {
    payload.nonce = nonce;
  }

  // Add access token hash if provided (for API calls)
  if (accessToken) {
    const tokenBytes = new TextEncoder().encode(accessToken);
    const hashBuffer = await crypto.subtle.digest("SHA-256", tokenBytes);
    const hashArray = new Uint8Array(hashBuffer);
    payload.ath = base64UrlEncode(hashArray);
  }

  const encoder = new TextEncoder();
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(signingInput)
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}

// ───────────────────────────────────────────────────────────────────────────
// 3.2 Media Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Download media from URL and return as Blob with metadata
 *
 * The timeout bounds the WHOLE read: the headers AND the body. A media host
 * that accepts the connection and then stops sending would otherwise hold the
 * worker for as long as the provider is willing to wait, and the worker is the
 * only thing that may settle the outcome.
 */
async function downloadMediaAsBlob(url: string, timeoutMs?: number): Promise<{
  blob: Blob;
  mimeType: string;
  size: number;
}> {
  const response = await fetch(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined);
  if (!response.ok) {
    throw new Error(`Failed to download media (${response.status})`);
  }
  const blob = await response.blob();
  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  return { blob, mimeType, size: blob.size };
}

/**
 * Download media from URL and return as ArrayBuffer with metadata
 */
async function downloadMediaAsArrayBuffer(url: string): Promise<{
  buffer: ArrayBuffer;
  bytes: Uint8Array;
  mimeType: string;
  size: number;
}> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media (${response.status})`);
  }
  const mimeType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return { buffer, bytes, mimeType, size: buffer.byteLength };
}

/**
 * Check if a URL points to a video file
 */
function isVideoUrl(url: string): boolean {
  const cleanUrl = url.split("?")[0].toLowerCase();
  if (/\.(mp4|mov|avi|wmv|webm|m4v|mkv|flv|3gp)$/.test(cleanUrl)) return true;
  if (cleanUrl.includes("/video/upload/")) return true; // Cloudinary video URLs
  return false;
}

/**
 * Compress a Cloudinary image URL on-the-fly so it stays under strict
 * platform limits (Threads 8MB, Instagram 8MB, etc.).
 *
 * Cloudinary accepts transformation segments in the URL path:
 *   https://res.cloudinary.com/<cloud>/image/upload/<transform>/<version>/<path>
 *
 * We inject `q_80,f_jpg` which:
 *   - converts PNG/WEBP → JPEG (much smaller for photographic content)
 *   - applies 80% quality (visually lossless, ~90-95% size reduction for large PNGs)
 *
 * For URLs that already have a transformation segment, we leave them alone.
 * Non-Cloudinary URLs are returned unchanged.
 *
 * Example: 8.27MB PNG → 0.31MB JPEG (96% reduction).
 */
function compressCloudinaryImageUrl(url: string): string {
  if (!url || typeof url !== "string") return url;
  if (!url.includes("res.cloudinary.com")) return url;
  if (!url.includes("/image/upload/")) return url;

  // Already has a transformation segment (anything other than a version
  // immediately after /image/upload/). Detect by checking if the segment
  // right after /image/upload/ starts with "v" followed by digits.
  const afterUpload = url.split("/image/upload/")[1] || "";
  // If the first path segment looks like "v1234567890" (pure version), there
  // is no transformation yet — safe to inject one.
  const firstSegment = afterUpload.split("/")[0] || "";
  const hasExistingTransform = !/^v\d+$/.test(firstSegment) && firstSegment !== "";
  if (hasExistingTransform) return url;

  // Inject `q_80,f_jpg` between /image/upload/ and the version path.
  // Using f_jpg forces JPEG output; q_80 is quality 80 (good balance).
  return url.replace(
    "/image/upload/",
    "/image/upload/q_80,f_jpg/"
  );
}

/**
 * Apply platform-safe image compression to a list of media URLs.
 * Videos are left untouched. Images get Cloudinary compression when available.
 */
function compressMediaUrlsForPlatform(urls: string[]): string[] {
  if (!Array.isArray(urls)) return urls;
  return urls.map((url) => (isVideoUrl(url) ? url : compressCloudinaryImageUrl(url)));
}

/**
 * Check if a URL points to an image file
 */
function isImageUrl(url: string): boolean {
  const cleanUrl = url.split("?")[0].toLowerCase();
  return /\.(jpg|jpeg|png|gif|webp|bmp)$/.test(cleanUrl);
}

// ───────────────────────────────────────────────────────────────────────────
// 3.3 Polling Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Generic polling function with configurable retry logic
 */
async function pollWithRetry<T>(
  checkFn: () => Promise<{ done: boolean; result?: T; error?: string }>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    backoff?: boolean;
  } = {}
): Promise<T> {
  const { maxAttempts = 30, delayMs = 2000, backoff = false } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { done, result, error } = await checkFn();

    if (error) {
      throw new Error(error);
    }

    if (done && result !== undefined) {
      return result;
    }

    const delay = backoff ? delayMs * Math.pow(1.5, attempt) : delayMs;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw new Error("Polling timed out");
}

// ───────────────────────────────────────────────────────────────────────────
// 3.4 Webhook Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Send webhook notifications to registered endpoints and per-request webhooks
 */
type AcknowledgedDelivery = {
  requireAcknowledgement: true;
  acknowledgedKeys?: ReadonlySet<string>;
  recordAcknowledgement?: (key: string) => Promise<void>;
};

async function postNotificationWebhook(url: string, request: RequestInit, delivery?: AcknowledgedDelivery): Promise<void> {
  const payload = delivery ? JSON.parse(String(request.body)) as { event: string; data: unknown } : null;
  const deliveryKey = payload ? await hashRequest({ channel: "webhook", url, event: payload.event, postId: (payload.data as Record<string, unknown>).post_id, platform: (payload.data as Record<string, unknown>).platform ?? null, postUrl: (payload.data as Record<string, unknown>).post_url ?? null }) : null;
  if (deliveryKey && delivery?.acknowledgedKeys?.has(deliveryKey)) return;
  const fetcher: typeof fetch = (target, init) => {
    if (!delivery) return fetch(target, init);
    const timeoutMs = followUpTimeoutMs(WORKER_STARTED_AT_MS, Date.now());
    if (timeoutMs <= 0) throw new Error("Final notification delivery budget exhausted");
    const signals = init?.signal ? [init.signal, AbortSignal.timeout(timeoutMs)] : [AbortSignal.timeout(timeoutMs)];
    return fetch(target, { ...init, signal: AbortSignal.any(signals) });
  };
  const response = await postWebhook(url, request, fetcher);
  if (delivery && !response.ok) throw new Error(`Final notification endpoint returned HTTP ${response.status}`);
  if (deliveryKey) await delivery?.recordAcknowledgement?.(deliveryKey);
}

async function sendWebhookNotifications(
  supabase: SupabaseClient,
  userId: string,
  event: string,
  data: Record<string, unknown>,
  perRequestWebhook?: { url: string; secret?: string },
  delivery?: AcknowledgedDelivery,
): Promise<void> {
  console.log(`Sending webhook notification: ${event} for user ${userId}`);
  const deliveryFailures: unknown[] = [];

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data
  };

  // Send to per-request webhook if provided
  if (perRequestWebhook?.url) {
    try {
      console.log(`Sending to per-request webhook: ${perRequestWebhook.url}`);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Postora-Event": event,
        "X-Postora-Timestamp": payload.timestamp,
        "X-Postora-Delivery-ID": crypto.randomUUID()
      };

      // Add HMAC signature if secret provided
      if (perRequestWebhook.secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(perRequestWebhook.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const signature = await crypto.subtle.sign(
          "HMAC",
          key,
          encoder.encode(JSON.stringify(payload))
        );
        const signatureHex = Array.from(new Uint8Array(signature))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");
        headers["X-Postora-Signature"] = `sha256=${signatureHex}`;
      }

      const validationError = validateWebhookTarget(perRequestWebhook.url);
      if (validationError) {
        if (delivery) throw new Error("Final notification webhook target is unsafe");
        console.warn(`Skipping unsafe per-request webhook: ${perRequestWebhook.url}`);
      } else {
        await postNotificationWebhook(perRequestWebhook.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        }, delivery);
        console.log("Per-request webhook sent successfully");
      }
    } catch (webhookError) {
      if (delivery) deliveryFailures.push(webhookError);
      else console.error("Failed to send per-request webhook:", webhookError);
    }
  }

  try {
    // Fetch user's registered webhooks
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("value")
      .like("key", `n8n_webhook_${userId}_%`);

    if (error && delivery) throw new Error(`Could not read final notification subscriptions: ${error.message}`);
    if (error || !settings?.length) {
      console.log("No registered webhooks found for user:", userId);
      if (!delivery) return;
    }

    // Send to all active webhooks that subscribe to this event
    for (const setting of settings ?? []) {
      const webhook = setting.value as {
        webhook_url: string;
        events: string[];
        is_active: boolean;
      };

      if (!webhook.is_active) continue;
      if (!webhook.events.includes(event) && !webhook.events.includes("*")) continue;

      try {
        const validationError = validateWebhookTarget(webhook.webhook_url);
        if (validationError) {
          if (delivery) throw new Error("Registered final notification webhook target is unsafe");
          console.warn(`Skipping unsafe registered webhook: ${webhook.webhook_url}`);
          continue;
        }
        console.log(`Sending to registered webhook: ${webhook.webhook_url}`);
        await postNotificationWebhook(webhook.webhook_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Postora-Event": event,
            "X-Postora-Timestamp": payload.timestamp
          },
          body: JSON.stringify(payload)
        }, delivery);
      } catch (webhookError) {
        if (delivery) deliveryFailures.push(webhookError);
        else console.error("Failed to send webhook:", webhookError);
      }
    }
  } catch (error) {
    if (delivery) deliveryFailures.push(error);
    else console.error("Error sending webhook notifications:", error);
  }
  if (deliveryFailures.length > 0) throw deliveryFailures[0];
}

// ───────────────────────────────────────────────────────────────────────────
// 3.5 Background Task Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Background polling for TikTok publish status
 * This runs after the HTTP response is sent using EdgeRuntime.waitUntil()
 */
async function pollTikTokPublishStatus(
  publishId: string,
  accessToken: string,
  username: string | null,
  platformPostId: string,
  postId: string,
  supabase: SupabaseClient,
  tiktokUsername?: string | null // The actual TikTok handle from account_metadata
): Promise<void> {
  console.log(`[Background] Starting TikTok status polling for publish_id: ${publishId}, tiktokUsername: ${tiktokUsername}`);

  const maxAttempts = 60; // Poll for up to 2 minutes
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    attempts++;

    try {
      const statusResponse = await fetch(
        "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ publish_id: publishId }),
        }
      );

      const statusData = await statusResponse.json();
      console.log(`[Background] TikTok status (attempt ${attempts}):`, JSON.stringify(statusData));

      if (statusData?.error?.code && statusData.error.code !== "ok") {
        console.error(`[Background] TikTok status check failed:`, statusData.error.message);
        break;
      }

      const status = statusData?.data?.status;

      if (status === "PUBLISH_COMPLETE") {
        // TikTok API may or may not return the video ID depending on the publishing method
        const publiclyAvailablePostId = firstPublicPostId(statusData?.data?.publicaly_available_post_id);
        let postUrl: string | undefined;

        // Prefer the tiktokUsername (the actual handle like "nonywaleed.tam201") over the display name
        // The username parameter might be a display name with unicode characters
        const effectiveUsername = tiktokUsername || username;
        const cleanUsername = effectiveUsername?.replace(/^@/, '');

        console.log(`[Background] Building TikTok URL - postId: ${publiclyAvailablePostId}, tiktokUsername: ${tiktokUsername}, username: ${username}, cleanUsername: ${cleanUsername}`);

        if (publiclyAvailablePostId && cleanUsername) {
          postUrl = `https://www.tiktok.com/@${cleanUsername}/video/${publiclyAvailablePostId}`;
        }

        console.log(`[Background] TikTok video published! Post ID: ${publiclyAvailablePostId}, URL: ${postUrl}`);

        // The terminal status, the parent roll-up and the post.published
        // enqueue are ONE database operation (Phase 7.4). Three separate client
        // calls -- as this was -- leave two crash windows: a worker killed
        // between them publishes a post the partner is never told about, and
        // the platform will not tell us again.
        const { error: settleError } = await settlePlatformPost(supabase, {
          platformPostId,
          postId,
          socialAccountId: null,
          platform: null,
          status: "success",
          providerPostId: publiclyAvailablePostId || publishId,
          providerPostUrl: postUrl,
        });
        if (settleError) {
          console.error(`[Background] Failed to settle platform_posts:`, settleError);
        }

        return;
      } else if (status === "FAILED") {
        const failReason = statusData?.data?.fail_reason || "Unknown reason";
        console.error(`[Background] TikTok publish failed:`, failReason);

        // Same single operation as the success branch. Note this REPLACES an
        // unconditional `posts.status = failed`: the seam's roll-up marks the
        // parent failed only when every target failed, because a two-platform
        // post where one worked is not a failed post. That is the one
        // deliberate behaviour change in 7.4 and it is recorded in the
        // decision record -- the two old writers disagreed with each other, so
        // one operation could not reproduce both.
        const { error: settleError } = await settlePlatformPost(supabase, {
          platformPostId,
          postId,
          socialAccountId: null,
          platform: null,
          status: "failed",
          errorMessage: `TikTok publish failed: ${failReason}`,
        });
        if (settleError) {
          console.error(`[Background] Failed to settle platform_posts:`, settleError);
        }

        return;
      }
      // Still processing, continue polling
    } catch (error) {
      console.error(`[Background] Polling error:`, error);
    }
  }

  console.warn(`[Background] TikTok polling timed out after ${maxAttempts} attempts`);
}

// ───────────────────────────────────────────────────────────────────────────
// 3.6 Email Notification Helper
// ───────────────────────────────────────────────────────────────────────────

interface PlatformResult {
  platform: string;
  status: string;
  platform_post_url?: string;
  error_message?: string;
}

/**
 * Send failure email notification to user (if enabled)
 */
async function sendFailureEmailNotification(
  supabase: SupabaseClient,
  userId: string,
  caption: string,
  platformResults: PlatformResult[],
  delivery?: AcknowledgedDelivery,
): Promise<void> {
  const deliveryKey = delivery ? await hashRequest({ channel: "failure_email", userId }) : null;
  if (deliveryKey && delivery?.acknowledgedKeys?.has(deliveryKey)) return;
  const acknowledge = async () => {
    if (deliveryKey) await delivery?.recordAcknowledgement?.(deliveryKey);
  };
  try {
    console.log(`[Email] Checking if failure email should be sent for user ${userId}`);

    // Check admin-level global toggle for user post failure emails
    const { data: settingRow, error: settingError } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_post_failure")
      .maybeSingle();

    if (settingError && delivery) throw new Error(`Could not read final notification email policy: ${settingError.message}`);
    if (settingRow) {
      const parsed = typeof settingRow.value === "string" ? JSON.parse(settingRow.value) : settingRow.value;
      if (parsed === false) {
        console.log("[Email] Post failure emails globally disabled by admin, skipping");
        await acknowledge();
        return;
      }
    }

    // Check if user has email notifications enabled
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("email_notifications_enabled")
      .eq("id", userId)
      .single();

    if (profileError) {
      if (delivery) throw new Error(`Could not read final notification email preferences: ${profileError.message}`);
      console.error("[Email] Could not fetch user profile:", profileError);
      return;
    }

    // Only send if user explicitly opted in (null and false both mean disabled)
    const emailEnabled = profile?.email_notifications_enabled === true;

    if (!emailEnabled) {
      console.log("[Email] Email notifications disabled for user, skipping");
      await acknowledge();
      return;
    }

    // Separate failed and successful platforms
    const failedPlatforms = platformResults
      .filter(r => r.status === "failed")
      .map(r => ({ platform: r.platform, error: r.error_message || "Unknown error" }));

    const successPlatforms = platformResults
      .filter(r => r.status === "success")
      .map(r => r.platform);

    if (failedPlatforms.length === 0) {
      console.log("[Email] No failed platforms, skipping email");
      return;
    }

    console.log(`[Email] Sending failure email: ${failedPlatforms.length} failed, ${successPlatforms.length} succeeded`);

    // Call the send-subscription-email function
    const { data: emailData, error: invokeError } = await supabase.functions.invoke("send-subscription-email", {
      body: {
        type: "post_failed",
        user_id: userId,
        data: {
          caption,
          failed_platforms: failedPlatforms,
          success_platforms: successPlatforms,
        },
      },
    });

    if (invokeError) {
      if (delivery) throw invokeError;
      console.error("[Email] Failed to invoke email function:", invokeError);
    } else if (delivery && (!emailData || typeof emailData !== "object" || (emailData as Record<string, unknown>).success !== true)) {
      throw new Error("Email function did not acknowledge delivery or an authorized opt-out");
    } else if (emailData && typeof emailData === "object" && (emailData as Record<string, unknown>).success === false) {
      const message = (emailData as Record<string, unknown>).message || "Email delivery failed";
      if (delivery) throw new Error(`Email function reported failure: ${message}`);
      console.error("[Email] Email function reported failure:", emailData);
    } else {
      await acknowledge();
      console.log("[Email] Failure notification email sent successfully");
    }
  } catch (error) {
    if (delivery) throw error;
    console.error("[Email] Error sending failure notification:", error);
  }
}

/**
 * Step 6: tell the user and their webhooks that the post is final (non-blocking). Used by the
 * run that finishes the post, whether that is the first run, a resumed run, or one that gave a
 * deferred account up: whoever makes the post terminal reports all of it.
 */
function sendFinalNotifications(
  supabase: SupabaseClient,
  post: PostData,
  finalStatus: string,
  platformResults: PlatformResultSummary[],
  hasFailed: boolean,
): void {
  const webhookEvent = finalStatus === "completed" ? "post.completed" : "post.failed";
  const webhookData = {
    post_id: post.id,
    caption: post.caption,
    platforms: post.platforms,
    status: finalStatus,
    // The legacy per-platform map, plus platform_results_list with one entry per row.
    ...buildWebhookResults(platformResults),
  };

  // Extract per-request webhook configuration from post metadata
  const perRequestWebhook = post.metadata?.webhook_url ? {
    url: post.metadata.webhook_url as string,
    secret: post.metadata.webhook_secret as string | undefined
  } : undefined;

  // Use EdgeRuntime.waitUntil for non-blocking webhook delivery
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(sendWebhookNotifications(supabase, post.user_id, webhookEvent, webhookData, perRequestWebhook));

    // Also send individual post.published events for each successful platform
    for (const result of platformResults) {
      if (result.status === "success" && result.platform_post_url) {
        EdgeRuntime.waitUntil(sendWebhookNotifications(supabase, post.user_id, "post.published", {
          post_id: post.id,
          platform: result.platform,
          post_url: result.platform_post_url,
          caption: post.caption
        }, perRequestWebhook));
      }
    }
    // Send email notification for failed posts (non-blocking)
    if (hasFailed) {
      EdgeRuntime.waitUntil(sendFailureEmailNotification(supabase, post.user_id, post.caption || "", platformResults));
    }
  } else {
    // Fallback: send synchronously but don't block response
    sendWebhookNotifications(supabase, post.user_id, webhookEvent, webhookData, perRequestWebhook).catch(console.error);

    // Send email notification for failed posts
    if (hasFailed) {
      sendFailureEmailNotification(supabase, post.user_id, post.caption || "", platformResults).catch(console.error);
    }
  }
}

async function dispatchFinalNotifications(
  supabase: SupabaseClient,
  post: PostData,
  finalStatus: string,
  platformResults: PlatformResultSummary[],
  hasFailed: boolean,
  delivery: AcknowledgedDelivery,
): Promise<void> {
  const webhookEvent = finalStatus === "completed" ? "post.completed" : "post.failed";
  const webhookData = {
    post_id: post.id,
    caption: post.caption,
    platforms: post.platforms,
    status: finalStatus,
    ...buildWebhookResults(platformResults),
  };

  const perRequestWebhook = post.metadata?.webhook_url ? {
    url: post.metadata.webhook_url as string,
    secret: post.metadata.webhook_secret as string | undefined,
  } : undefined;

  const tasks: Promise<unknown>[] = [
    sendWebhookNotifications(supabase, post.user_id, webhookEvent, webhookData, perRequestWebhook, delivery),
  ];

  if (typeof (globalThis as Record<string, unknown>).EdgeRuntime !== "undefined" && typeof (globalThis as { EdgeRuntime?: { waitUntil?: unknown } }).EdgeRuntime?.waitUntil === "function") {
    for (const result of platformResults) {
      if (result.status === "success" && result.platform_post_url) {
        tasks.push(
          sendWebhookNotifications(supabase, post.user_id, "post.published", {
            post_id: post.id,
            platform: result.platform,
            post_url: result.platform_post_url,
            caption: post.caption,
          }, perRequestWebhook, delivery)
        );
      }
    }
  }

  if (hasFailed) {
    tasks.push(sendFailureEmailNotification(supabase, post.user_id, post.caption || "", platformResults, delivery));
  }

  const delivered = await Promise.allSettled(tasks);
  const failed = delivered.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Announce a final post once. Every path that makes a post final (the first run, a resumed run,
 * a given-up account) goes through here: the claim is atomic, so two runs that settle the last
 * rows at the same moment cannot both send. Returns whether this run sent.
 */
async function announceFinalPost(
  supabase: SupabaseClient,
  post: PostData,
  finalStatus: string,
  platformResults: PlatformResultSummary[],
  hasFailed: boolean,
  imageFence?: { processingStartedAt: string; content: Record<string, unknown> },
): Promise<boolean> {
  if (imageFence) {
    const claim = await claimThreadsImageNotification(
      supabase,
      post.id,
      imageFence.processingStartedAt,
      finalStatus,
      imageFence.content,
    );
    if (!claim.claimed || !claim.claimId) {
      await writeLogRow(supabase, {
        level: claim.error ? "warn" : "info", category: "post", source: "process-post", user_id: post.user_id,
        message: "Threads image final notification claim was refused; no notice was sent",
        metadata: { event: "threads_image_notification_claim_refused", post_id: post.id, reason: claim.error ?? "already claimed" },
      });
      return false;
    }
    try {
      if (!claim.authorizedPlatformPostIds?.length || !claim.authorizedPlatformPostStatuses) {
        await writeLogRow(supabase, {
          level: "error", category: "post", source: "process-post", user_id: post.user_id,
          message: "Threads image notification withheld because its leased result scope is missing",
          metadata: { event: "threads_image_notification_invalid_scope", post_id: post.id },
        });
        return false;
      }
      {
        const outcome = await readPostOutcome(
          postReaderFor(supabase, claim.authorizedPlatformPostIds, claim.authorizedPlatformPostStatuses, imageFence),
          post.id,
          { results: platformResults, hasSuccess: finalStatus === "completed", hasFailed },
        );
        if (outcome.kind !== "terminal" || outcome.degraded || outcome.status !== finalStatus) {
          await writeLogRow(supabase, {
            level: "error", category: "post", source: "process-post", user_id: post.user_id,
            message: "Threads image notification withheld because its leased result rows changed or could not be completely read",
            metadata: { event: "threads_image_notification_read_degraded", post_id: post.id },
          });
          return false;
        }
        platformResults = outcome.results;
        hasFailed = outcome.hasFailed;
      }
      const acknowledgedKeys = new Set(claim.acknowledgedDeliveryKeys ?? []);
      const delivery: AcknowledgedDelivery = {
        requireAcknowledgement: true,
        acknowledgedKeys,
        recordAcknowledgement: async (key) => {
          const { data: recorded, error } = await supabase.rpc("ack_threads_image_notification_delivery", {
            p_post_id: post.id, p_expected_processing_started_at: imageFence.processingStartedAt,
            p_claim_id: claim.claimId!, p_delivery_key: key,
          });
          if (error || recorded !== true) throw new Error("Notification destination acknowledgement could not be persisted");
          acknowledgedKeys.add(key);
        },
      };
      await dispatchFinalNotifications(supabase, post, finalStatus, platformResults, hasFailed, delivery);
      const confirmed = await confirmThreadsImageNotification(
        supabase,
        post.id,
        imageFence.processingStartedAt,
        finalStatus,
        imageFence.content,
        claim.claimId,
      );
      if (!confirmed.confirmed) {
        await writeLogRow(supabase, {
          level: "error", category: "post", source: "process-post", user_id: post.user_id,
          message: "Threads image notification delivery could not be confirmed; intent retained",
          metadata: { event: "threads_image_notification_confirmation_refused", post_id: post.id, reason: confirmed.error },
        });
        return false;
      }
      return true;
    } catch (err) {
      const deliveryError = (err instanceof Error ? err.message : "Unknown notification delivery failure")
        .replace(/https?:\/\/\S+/gi, "[redacted URL]")
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .slice(0, 500);
      const logError = await writeLogRow(supabase, {
        level: "error", category: "post", source: "process-post", user_id: post.user_id,
        message: "Threads image final notification delivery failed; intent retained for recovery",
        metadata: {
          event: "threads_image_notification_delivery_failed", post_id: post.id,
          notification_claim_id: claim.claimId, attempt_started_at: imageFence.processingStartedAt,
          delivery_error: deliveryError,
        },
      });
      if (logError) console.error("Threads image notification diagnostic could not be persisted:", logError);
      return false;
    }
  }

  const claim = await claimFinalNotification(supabase, post.id);
  if (claim.reason === "legacy_candidate") {
    const response = await handleNotificationOnly(supabase, post.id);
    const receipt = await response.json();
    return response.ok && receipt.notification_scheduled === true;
  }
  if (claim.reason) {
    await writeLogRow(supabase, {
      level: claim.error ? "warn" : "info", category: "post", source: "process-post", user_id: post.user_id,
      message: claim.reason === "managed_intent" ? "Managed image notification remains owned by its fenced reconciler" : "Final notification withheld because its current ownership could not be established",
      metadata: { event: "final_notification_claim_refused", post_id: post.id, reason: claim.reason, error: claim.error },
    });
    return false;
  }
  if (claim.error) {
    // Only marker UPDATE errors follow a successful legacy ownership read.
    // Unknown/missing ownership and managed refusals returned above.
    await writeLogRow(supabase, {
      level: "warn", category: "post", source: "process-post", user_id: post.user_id,
      message: "Legacy notification marker unavailable; attempting best-effort delivery",
      metadata: { event: "legacy_notification_claim_error", post_id: post.id, reason: claim.error },
    });
  } else if (!claim.claimed) {
    console.log(`[process-post] post ${post.id} was already announced; not sending again`);
    return false;
  }
  sendFinalNotifications(supabase, post, finalStatus, platformResults, hasFailed);
  return true;
}

/** The reads readPostOutcome needs, against the service-role client. */
function postReaderFor(
  supabase: SupabaseClient,
  authorizedPlatformPostIds?: string[] | null,
  expectedStatuses?: Record<string, string>,
  imageFence?: { processingStartedAt: string; content: Record<string, unknown> },
): PostReader {
  return {
    postStatus: async (postId) => {
      const result = await supabase.from("posts").select(imageFence ? "*" : "status").eq("id", postId).maybeSingle();
      if (!result.error && result.data && imageFence) {
        const current = result.data as PostData;
        const expectedContent = {
          ...imageFence.content,
          metadata: normalizeThreadsInternalMetadata(imageFence.content.metadata as Record<string, unknown> | null | undefined),
        };
        if (Date.parse(current.processing_started_at ?? "") !== Date.parse(imageFence.processingStartedAt) ||
          await hashRequest(threadsImageContentFence(current)) !== await hashRequest(expectedContent)) {
          return { data: null, error: { message: "Managed notification attempt or content changed before dispatch" } };
        }
      }
      return result;
    },
    platformRows: async (postId) => {
      let query = supabase
        .from("platform_posts")
        .select("id, platform, status, platform_post_url, error_message, story_on_reel:response_data->story_recorded_on_reel_row")
        .eq("post_id", postId);
      if (Array.isArray(authorizedPlatformPostIds)) {
        if (authorizedPlatformPostIds.length === 0) {
          return { data: [], error: null };
        }
        query = query.in("id", authorizedPlatformPostIds);
      }
      const res = await query.order("created_at");
      if (res.error) return res;
      if (Array.isArray(authorizedPlatformPostIds)) {
        const returnedIds = new Set((res.data ?? []).map((r: { id: string }) => r.id));
        const expectedIds = new Set(authorizedPlatformPostIds);
        if (expectedIds.size !== authorizedPlatformPostIds.length || returnedIds.size !== expectedIds.size || (res.data ?? []).length !== expectedIds.size ||
          !authorizedPlatformPostIds.every((id) => returnedIds.has(id)) ||
          (res.data ?? []).some((row: { id: string; status: string }) =>
            !["success", "failed"].includes(row.status) || (expectedStatuses && expectedStatuses[row.id] !== row.status))) {
          return {
            data: null,
            error: {
              message: `Authorized platform post rows could not be completely read (expected ${authorizedPlatformPostIds.length}, got ${returnedIds.size})`,
              details: "",
              hint: "",
              code: "PGRST_DEGRADED_ROW_SET",
            },
          };
        }
      }
      return res;
    },
  };
}

function imageAttemptFence(
  deferral: ResumeContext["deferral"],
  responseData: Record<string, unknown> | null,
): { processingStartedAt: string; content: Record<string, unknown> } | undefined {
  const content = responseData?.content_fence;
  if (deferral.media_type !== "IMAGE" || !deferral.attempt_started_at ||
    !content || typeof content !== "object" || Array.isArray(content)) return undefined;
  return { processingStartedAt: deferral.attempt_started_at, content: content as Record<string, unknown> };
}

/**
 * After a resumed run settled a deferred account (or gave it up): where the post stands, and,
 * when this settle made it final, its notifications. A post that cannot be read is logged as an
 * error, never treated as unfinished, so a lost notification leaves a trace.
 */
async function finishDeferredPost(
  supabase: SupabaseClient,
  post: PostData,
  platformPostId: string,
  thisRun: { results: PlatformResultSummary[]; hasSuccess: boolean; hasFailed: boolean },
  imageFence?: { processingStartedAt: string; content: Record<string, unknown> },
): Promise<{ finalStatus: string; notified: boolean }> {
  let imageFinalization: {
    status: string;
    stale: boolean;
    notify: boolean;
    authorizedPlatformPostIds?: string[];
  } | null = null;
  if (imageFence) {
    const { data: finalized, error: finalizationError } = await supabase.rpc("finalize_threads_image_attempt", {
      p_post_id: post.id,
      p_expected_processing_started_at: imageFence.processingStartedAt,
      p_expected_content: imageFence.content,
    });
    const finalization = finalized as {
      status?: unknown;
      stale?: unknown;
      notify?: unknown;
      authorized_platform_post_ids?: unknown;
      reason?: unknown;
    } | null;
    if (finalizationError || typeof finalization?.status !== "string" ||
      typeof finalization.stale !== "boolean" || typeof finalization.notify !== "boolean") {
      const logError = await writeLogRow(supabase, {
        level: "error", category: "post", source: "process-post", user_id: post.user_id,
        message: "Threads image final notification fence could not be confirmed; no notice was sent",
        metadata: { event: "threads_image_finalization_unavailable", post_id: post.id, platform_post_id: platformPostId },
      });
      if (logError) console.error("Threads image finalization refusal log failed:", logError);
      return { finalStatus: "processing", notified: false };
    }
    if (finalization.reason === "fanout_not_closed") {
      await writeLogRow(supabase, { level: "warn", category: "post", source: "process-post", user_id: post.user_id,
        message: "Threads image completion withheld until the original multi-result fanout is proven",
        metadata: { event: "threads_image_fanout_unconfirmed", post_id: post.id, platform_post_id: platformPostId } });
      return { finalStatus: finalization.status, notified: false };
    }
    let authorizedIds: string[] | undefined = undefined;
    if (Array.isArray(finalization.authorized_platform_post_ids)) {
      authorizedIds = finalization.authorized_platform_post_ids.filter((id): id is string => typeof id === "string");
    } else {
      const metadata = (post.metadata ?? {}) as Record<string, unknown>;
      const intent = metadata.final_notification_intent as Record<string, unknown> | undefined;
      if (intent && Array.isArray(intent.authorized_platform_post_ids)) {
        authorizedIds = intent.authorized_platform_post_ids.filter((id): id is string => typeof id === "string");
      }
    }
    imageFinalization = {
      status: finalization.status,
      stale: finalization.stale,
      notify: finalization.notify,
      authorizedPlatformPostIds: authorizedIds,
    };
    const metadata = (post.metadata ?? {}) as Record<string, unknown>;
    const unconfirmedNotification =
      metadata.final_notification_intent &&
      typeof metadata.final_notification_intent === "object" &&
      (metadata.final_notification_intent as Record<string, unknown>).notified === false;

    if (imageFinalization.stale || imageFinalization.status === "processing" ||
        (!imageFinalization.notify && !unconfirmedNotification)) {
      return { finalStatus: imageFinalization.status, notified: false };
    }
  }

  const outcome = await readPostOutcome(
    postReaderFor(supabase, imageFinalization ? (imageFinalization.authorizedPlatformPostIds ?? []) : undefined),
    post.id,
    thisRun,
  );
  if (outcome.kind === "in_progress") return { finalStatus: "processing", notified: false };
  if (outcome.kind === "unknown") {
    console.error(`[process-post] ${outcome.error}`);
    const logError = await writeLogRow(supabase, unreadableOutcomeLog(post.user_id, post.id, platformPostId, outcome.error));
    if (logError) console.error("[process-post] could not log the unreadable post either:", logError);
    return { finalStatus: "processing", notified: false };
  }
  if (outcome.degraded) {
    console.warn(`[process-post] notifying with a partial read: ${outcome.degraded}`);
    if (imageFinalization) {
      await writeLogRow(supabase, {
        level: "error", category: "post", source: "process-post", user_id: post.user_id,
        message: "Threads image final notification withheld because authorized platform post rows could not be completely read",
        metadata: { event: "threads_image_notification_read_degraded", post_id: post.id, platform_post_id: platformPostId, degraded: outcome.degraded },
      });
      return { finalStatus: imageFinalization.status, notified: false };
    }
  }
  if (imageFinalization) {
    const notified = await announceFinalPost(supabase, post, imageFinalization.status, outcome.results, outcome.hasFailed, imageFence);
    return { finalStatus: imageFinalization.status, notified };
  }
  const notified = await announceFinalPost(supabase, post, outcome.status, outcome.results, outcome.hasFailed);
  return { finalStatus: outcome.status, notified };
}

/**
 * Handle notification_only requests: strictly validate claim and enrollment,
 * atomically claim legacy notification candidate, read exact authorized results,
 * dispatch notifications, and return immediately.
 * Never executes any provider calls, media downloads, or processing claims.
 */
async function handleNotificationOnly(
  supabase: SupabaseClient,
  postId: string,
  expectedProcessingStartedAt?: string,
  expectedCandidateId?: string,
  expectedClaimId?: string,
): Promise<Response> {
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("*")
    .eq("id", postId)
    .maybeSingle();

  if (postError || !post) {
    await writeLogRow(supabase, { level: "warn", category: "post", source: "process-post", message: "Notification recovery could not read its parent", metadata: { event: "legacy_notification_parent_unavailable", post_id: postId } });
    return createErrorResponse("Notification parent unavailable", 503);
  }

  const attemptStartedAt = expectedProcessingStartedAt ?? post.processing_started_at;
  if (!attemptStartedAt) {
    return createErrorResponse("Attempt started timestamp unavailable", 400);
  }

  const expectedContent = threadsImageContentFence(post as PostData);
  const candidate = post.metadata?.legacy_notification_candidate;
  const authorizedIds = candidate?.authorized_platform_post_ids;
  if (!candidate || typeof candidate.candidate_id !== "string" || !candidate.candidate_id ||
      !Array.isArray(authorizedIds) || authorizedIds.length === 0 ||
      !authorizedIds.every((id: unknown) => typeof id === "string")) {
    await writeLogRow(supabase, { level: "warn", category: "post", source: "process-post", user_id: post.user_id, message: "Notification recovery has no proven complete result scope", metadata: { event: "legacy_notification_scope_unavailable", post_id: postId } });
    return createErrorResponse("Notification scope unavailable", 503);
  }
  // Read before consuming the send-once marker. Database outages remain pre-claim work.
  // The locked claim refreshes stale status snapshots and refuses their old candidate ID.
  const outcome = await readPostOutcome(postReaderFor(supabase, authorizedIds, undefined, {
    processingStartedAt: attemptStartedAt, content: expectedContent,
  }), postId, { results: [], hasSuccess: false, hasFailed: false });
  if (outcome.kind !== "terminal" || outcome.degraded) {
    await writeLogRow(supabase, { level: "warn", category: "post", source: "process-post", user_id: post.user_id, message: "Notification recovery withheld an incomplete result read", metadata: { event: "legacy_notification_results_unavailable", post_id: postId } });
    return createErrorResponse("Notification results unavailable", 503);
  }
  const { data: claimData, error: claimError } = await supabase.rpc("claim_legacy_notification_candidate", {
    p_post_id: post.id,
    p_expected_processing_started_at: attemptStartedAt,
    p_expected_content: expectedContent,
    p_candidate_id: expectedCandidateId ?? candidate.candidate_id,
    p_claim_id: expectedClaimId ?? null,
  });

  const claimRes = claimData as {
    claimed?: boolean;
    claim_id?: string;
    status?: string;
    authorized_platform_post_ids?: string[];
    reason?: string;
  } | null;

  if (claimError || !claimRes?.claimed) {
    const reason = claimRes?.reason ?? claimError?.message ?? "claim_refused";
    await writeLogRow(supabase, { level: "warn", category: "post", source: "process-post", user_id: post.user_id, message: "Notification recovery claim refused", metadata: { event: "legacy_notification_candidate_refused", post_id: postId, reason: claimError ? "claim_unavailable" : reason } });
    if (claimError) return createErrorResponse("Notification claim unavailable", 503);
    return createJsonResponse({
      success: true,
      notification_only: true,
      claimed: false,
      reason,
    });
  }

  if (claimRes.status !== outcome.status || !Array.isArray(claimRes.authorized_platform_post_ids) ||
      claimRes.authorized_platform_post_ids.length !== authorizedIds.length ||
      !authorizedIds.every((id: string) => claimRes.authorized_platform_post_ids!.includes(id))) {
    await writeLogRow(supabase, { level: "error", category: "post", source: "process-post", user_id: post.user_id, message: "Notification claim returned an inconsistent snapshot", metadata: { event: "legacy_notification_claim_snapshot_invalid", post_id: postId } });
    return createErrorResponse("Notification claim snapshot invalid", 503);
  }
  const finalStatus = outcome.status;
  sendFinalNotifications(supabase, post as PostData, finalStatus, outcome.results, outcome.hasFailed);

  return createJsonResponse({
    success: true,
    notification_only: true,
    claimed: true,
    notification_scheduled: true,
    status: finalStatus,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: MAIN REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Pollers that can defer a container stop waiting a fixed time after this.
  const requestStartedAt = Date.now();

  try {
    // Parse request body first (can only be consumed once)
    // Supports optional `platforms` and `account_ids` for single-platform retry
    const rawBody = await req.json();
    const validation = validateRequestBody(ProcessPostSchema, rawBody);
    if (!validation.success) {
      return new Response(JSON.stringify({ error: validation.error, details: validation.details }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const {
      post_id,
      expected_scheduled_at: expectedScheduledAt,
      expected_publish_requested_at: expectedPublishRequestedAt,
      resume_platform_post_id: resumePlatformPostId,
      notification_only: notificationOnly,
      attempt_started_at: attemptStartedAt,
      candidate_id: candidateId,
      notification_claim_id: notificationClaimId,
      resume_youtube_upload_session_id: resumeYoutubeUploadSessionId,
      resume_youtube_upload_lease_token: resumeYoutubeUploadLeaseToken,
    } = validation.data;
    // A resumed run narrows both to the deferred row's account (below).
    let { platforms: overridePlatforms, account_ids: overrideAccountIds } = validation.data;

    if (!post_id) {
      return createErrorResponse("Missing post_id", 400);
    }

    console.log("Processing post:", post_id, {
      overridePlatforms: overridePlatforms || null,
      overrideAccountIds: overrideAccountIds || null
    });

    // ─────────────────────────────────────────────────────────────────────
    // Step 0: Authenticate user or service role
    // ─────────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("Missing or invalid Authorization header");
      return createErrorResponse("Unauthorized: missing Authorization header", 401);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      console.log("Missing bearer token");
      return createErrorResponse("Unauthorized: missing bearer token", 401);
    }

    // Use service role for database operations
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let authenticatedUserId: string | null = null;
    let isServiceRoleAuth = false;

    // Check if this is a service role key (used by scheduled posts, n8n-api, etc.)
    if (token === SUPABASE_SERVICE_ROLE_KEY) {
      console.log("Service role authentication - server-to-server call");
      isServiceRoleAuth = true;
    } else {
      // Validate JWT using anon key client with auth header
      const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });

      const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);

      if (claimsError || !claimsData?.claims) {
        console.log("JWT validation failed", { error: claimsError?.message });
        return createErrorResponse("Unauthorized: invalid token", 401);
      }

      authenticatedUserId = claimsData.claims.sub as string;
      console.log("User authenticated", { userId: authenticatedUserId });
    }

    const refuseNotificationRoute = async (reason: string, message: string, status: number) => {
      await writeLogRow(supabase, {
        level: "warn", category: "post", source: "process-post", user_id: authenticatedUserId,
        message: "Notification-only routing refused",
        metadata: { event: "notification_route_refused", post_id, reason },
      });
      return createErrorResponse(message, status);
    };
    const refuseDispatchMode = async (reason: string, message: string, status: number) => {
      await writeLogRow(supabase, {
        level: "warn", category: "post", source: "process-post", user_id: authenticatedUserId,
        message: "Dispatch mode refused",
        metadata: { event: "dispatch_mode_refused", post_id, reason },
      });
      console.warn(`[process-post] dispatch refused for post ${post_id}: ${reason}`);
      return createErrorResponse(message, status);
    };

    // ─────────────────────────────────────────────────────────────────────
    // The dispatch modes are exclusive.
    //
    // A request carries ONE of them:
    //
    //   * the NOTIFICATION mode. The reconciler hands over a candidate that
    //     still needs its final notification, with a claim identity.
    //   * the YOUTUBE CONTINUATION mode. The reconciler hands over an upload
    //     session that has to be carried on, with a claim token.
    //   * the PUBLICATION mode. Everything else, which publishes the post.
    //
    // The modes are told apart by their OWN identity, and the attempt is read
    // as part of the identity of the mode that carries it. The attempt is
    // therefore never refused on its own: it belongs to the notification mode
    // and to the continuation mode, and only the publication mode has no
    // identity at all.
    //
    // A request that carries two identities is refused before anything is
    // read, written or sent to a provider.
    // ─────────────────────────────────────────────────────────────────────
    const carriesNotificationIdentity = Boolean(attemptStartedAt || candidateId || notificationClaimId);
    const carriesYoutubeIdentity = Boolean(resumeYoutubeUploadSessionId || resumeYoutubeUploadLeaseToken);

    if (notificationOnly) {
      // The notification mode owns the attempt and the claim identity.
      if (!attemptStartedAt || !candidateId || !notificationClaimId) {
        return await refuseNotificationRoute("invalid_identity", "Combined mode rejected: notification_only requires a lease identity", 400);
      }
      if (carriesYoutubeIdentity || resumePlatformPostId || overridePlatforms?.length || overrideAccountIds?.length ||
          expectedScheduledAt || expectedPublishRequestedAt) {
        return await refuseNotificationRoute("invalid_identity_or_combined_mode", "Combined mode rejected: notification_only requires a lease identity and cannot be combined with publish or resume parameters", 400);
      }
      if (!isServiceRoleAuth) {
        return await refuseNotificationRoute("service_role_required", "Forbidden: notification_only is internal", 403);
      }
      return await handleNotificationOnly(supabase, post_id, attemptStartedAt, candidateId, notificationClaimId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // YouTube upload continuation.
    //
    // A worker that did not finish a YouTube upload leaves the session
    // behind. The reconciler claims it and asks this function to carry it on.
    //
    // The dispatch carries the session id and the claim token. It does NOT
    // carry the session URI: the URI stays in the private session table and
    // is read here with the token, so the credential never travels in a
    // request body and never appears in a response.
    // ─────────────────────────────────────────────────────────────────────
    if (carriesYoutubeIdentity) {
      if (!resumeYoutubeUploadSessionId || !resumeYoutubeUploadLeaseToken) {
        return await refuseDispatchMode("youtube_identity_incomplete", "The upload continuation needs both the session and the claim token.", 400);
      }
      // The attempt is part of the identity of a continuation.
      //
      // The continuation is fenced to one attempt of the post, and the fence is
      // the attempt itself. A dispatch without one cannot be compared with the
      // post, so it is refused here rather than accepted and carried on: the
      // attempt-level routing fence has to hold, and it cannot hold what it
      // cannot compare.
      if (!attemptStartedAt) {
        return await refuseDispatchMode("youtube_attempt_missing", "The upload continuation needs the attempt it belongs to.", 400);
      }
      if (carriesNotificationIdentity && (candidateId || notificationClaimId)) {
        return await refuseDispatchMode("youtube_combined_mode", "The upload continuation cannot be combined with another mode.", 400);
      }
      if (resumePlatformPostId || overridePlatforms?.length || overrideAccountIds?.length ||
          expectedScheduledAt || expectedPublishRequestedAt) {
        return await refuseDispatchMode("youtube_combined_mode", "The upload continuation cannot be combined with another mode.", 400);
      }
      if (!isServiceRoleAuth) {
        return await refuseDispatchMode("service_role_required", "Forbidden: the upload continuation is internal", 403);
      }
      return await handleYoutubeUploadContinuation(
        supabase,
        post_id,
        resumeYoutubeUploadSessionId,
        resumeYoutubeUploadLeaseToken,
        attemptStartedAt,
      );
    }

    // The publication mode has no identity of its own.
    if (carriesNotificationIdentity) {
      // An attempt or a claim identity only means something in the mode that
      // owns it. Carrying one in the publication mode is a routing mistake,
      // and it is refused before anything is read, claimed or sent.
      //
      // The refusal keeps the notification routing diagnostic, because that
      // is the shape that was refused: an identity whose mode is missing.
      return await refuseNotificationRoute(
        "identity_without_mode",
        "Notification identity requires notification_only mode",
        400,
      );
    }

    // A run its caller retries on its own is not started on a worker near its end: it would be
    // stopped between creating a container and recording it. Refused before any read or claim.
    if (refuseOnSpentWorker({ resume: !!resumePlatformPostId, scheduled: typeof expectedScheduledAt === "string" || typeof expectedPublishRequestedAt === "string" }, WORKER_STARTED_AT_MS, Date.now())) {
      console.warn(`[process-post] worker too old to start post ${post_id}; the caller retries on a fresh one`);
      const logError = await writeLogRow(supabase, {
        level: "info", category: "post", source: "process-post", message: "worker_admission_refused",
        user_id: authenticatedUserId, metadata: { post_id },
      });
      if (logError) console.error("worker_admission_refused log failed:", logError);
      return createErrorResponse("This worker is about to stop, so the run was not started. Retrying shortly is safe.", 503);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 1: Get post details and verify ownership
    // ─────────────────────────────────────────────────────────────────────
    const { data: post, error: postError } = await supabase
      .from("posts")
      .select("*")
      .eq("id", post_id)
      .single();

    if (postError || !post) {
      return createErrorResponse("Post not found", 404);
    }

    // Verify the authenticated user owns this post (skip for service role)
    if (!isServiceRoleAuth && post.user_id !== authenticatedUserId) {
      console.log("Unauthorized: user does not own this post", {
        postUserId: post.user_id,
        authenticatedUserId
      });
      return createErrorResponse("Forbidden: you do not own this post", 403);
    }

    console.log("Post data:", { platforms: post.platforms, caption: post.caption?.substring(0, 50) });

    // Resume mode: finish one deferred Meta container. Only the reconciler calls it.
    let resume: ResumeContext | null = null;
    let resumeResponseData: Record<string, unknown> | null = null;
    if (resumePlatformPostId) {
      if (!isServiceRoleAuth) return createErrorResponse("Forbidden: resume is internal", 403);
      const { data: row, error: rowError } = await supabase
        .from("platform_posts")
        .select("id, social_account_id, platform, status, response_data")
        .eq("id", resumePlatformPostId)
        .eq("post_id", post_id)
        .maybeSingle();
      // A failed read is not "nothing deferred": answer retryable and touch nothing.
      if (rowError) return createErrorResponse(`Could not read the deferred row: ${rowError.message}`, 503);
      let deferral = row?.status === "pending" ? readDeferral(row.response_data) : null;
      if (row && (row.status === "success" || row.status === "failed")) {
        const terminalDeferral = readDeferral(row.response_data);
        const fence = terminalDeferral
          ? imageAttemptFence(terminalDeferral, (row.response_data as Record<string, unknown> | null) ?? {})
          : undefined;
        if (fence) {
          const finished = await finishDeferredPost(supabase, post, row.id, {
            results: [], hasSuccess: false, hasFailed: false,
          }, fence);
          return createJsonResponse({
            success: true,
            status: "skipped",
            reason: "Threads image row is already terminal",
            post_status: finished.finalStatus,
            notified: finished.notified,
          });
        }
      }
      if (!row || !deferral || !row.social_account_id) {
        return createJsonResponse({ success: true, status: "skipped", reason: "nothing deferred on this row" });
      }
      // Image expiry/edit/cancel abandonment needs the same execution owner as a
      // normal resume; terminal settlement never bypasses lease ownership.
      if (deferral.media_type === "IMAGE") {
        if (!deferral.claimed_until) {
          const logError = await writeLogRow(supabase, {
            level: "warn", category: "post", source: "process-post", user_id: post.user_id,
            message: "Threads image resume refused without a reconciliation lease",
            metadata: { event: "threads_image_lease_missing", post_id, platform_post_id: row.id },
          });
          if (logError) console.error("Threads image lease refusal log failed:", logError);
          return createErrorResponse("Threads image checkpoint has no active reconciliation lease; retry shortly.", 503);
        }
        const executionId = crypto.randomUUID();
        const { data: executionClaimed, error: executionError } = await supabase.rpc("claim_threads_image_execution", {
          p_platform_post_id: row.id,
          p_expected_claimed_until: deferral.claimed_until,
          p_execution_id: executionId,
        });
        if (executionError) {
          const logError = await writeLogRow(supabase, {
            level: "error", category: "post", source: "process-post", user_id: post.user_id,
            message: "Threads image execution claim unavailable; no provider call was made",
            metadata: { post_id, platform_post_id: row.id },
          });
          if (logError) console.error("Threads image execution refusal log failed:", logError);
          return createErrorResponse("Threads image execution could not be claimed. Retry shortly.", 503);
        }
        if (executionClaimed !== true) {
          const logError = await writeLogRow(supabase, {
            level: "info", category: "post", source: "process-post", user_id: post.user_id,
            message: "Threads image resume refused because the execution lease is already owned or stale",
            metadata: { event: "threads_image_execution_refused", post_id, platform_post_id: row.id },
          });
          if (logError) console.error("Threads image execution refusal log failed:", logError);
          return createJsonResponse({ success: true, status: "processing", reason: "another execution owns this lease" });
        }
        deferral = { ...deferral, execution_id: executionId, execution_claimed_until: deferral.claimed_until };
        resumeResponseData = { ...((row.response_data as Record<string, unknown> | null) ?? {}), deferred: deferral };
      }
      // Bounded whatever happens later in this request: a row past its deadline, or on
      // a post someone has since changed, is settled now rather than checked forever.
      const rowData = (row.response_data as Record<string, unknown> | null) ?? {};
      const rowFence = rowData.content_fence && typeof rowData.content_fence === "object"
        ? {
            ...(rowData.content_fence as Record<string, unknown>),
            metadata: normalizeThreadsInternalMetadata((rowData.content_fence as Record<string, unknown>).metadata as Record<string, unknown> | null | undefined),
          }
        : rowData.content_fence;
      const contentChanged = deferral.media_type === "IMAGE" && rowFence !== undefined &&
        await hashRequest(rowFence) !== await hashRequest(threadsImageContentFence(post));
      const attemptChanged = deferral.media_type === "IMAGE" &&
        post.processing_started_at !== deferral.attempt_started_at;
      const abandon = abandonReason(deferral, contentChanged || attemptChanged ? "changed" : post.status, new Date());
      if (abandon) {
        // A live story the first run could not record is recorded before the reel is given up,
        // so the post rolls up with it and it is not lost with the abandoned row. If it still
        // cannot be recorded the reel is NOT settled: that would make the failure terminal and
        // strand the story. A 503 leaves the row pending with its carry, the reconciler comes
        // back next minute, and recording is idempotent so the retry is safe.
        const carried = await recordCarriedStory(supabase, {
          postId: post_id,
          socialAccountId: row.social_account_id,
          rowData: (row.response_data as Record<string, unknown> | null) ?? null,
        });
        // Past the grace window a story that still cannot get a row of its own is recorded on the
        // reel's row instead: that row settles as the account's live story (with the reel's
        // give-up in its error), so the post rolls up from rows that show the story, and a write
        // that never succeeds cannot keep the post in `processing` forever.
        const storyOnReelRow = carried.error !== null && storyRecoveryExhausted(deferral, new Date())
          ? readUnrecordedStory(row.response_data)
          : null;
        if (carried.error) {
          console.error(`[IG story] could not be recorded while giving up the reel: ${carried.error}`);
          if (!storyOnReelRow) {
            const logError = await writeLogRow(supabase, unrecordedStoryLog(post.user_id, post_id, row.id, carried.error));
            if (logError) console.error("[process-post] could not log the refusal either:", logError);
            return createErrorResponse(`Could not record the live Instagram story, so the reel was not given up: ${carried.error}`, 503);
          }
        }
        const settled = await settlePlatformPost(supabase, storyOnReelRow
          ? {
            platformPostId: row.id,
            postId: post_id,
            socialAccountId: row.social_account_id,
            platform: row.platform,
            status: "success",
            providerPostId: storyOnReelRow.id,
            providerPostUrl: storyOnReelRow.url,
            errorMessage: `${abandon} The Instagram Story from this post is live and is recorded on this row.`,
            responseData: storyOnReelRowData(row.response_data),
          }
          : {
            platformPostId: row.id,
            postId: post_id,
            socialAccountId: row.social_account_id,
            platform: row.platform,
            status: "failed",
            errorMessage: abandon,
            ...(deferral.media_type === "IMAGE"
              ? { responseData: { ...((row.response_data as Record<string, unknown> | null) ?? {}), deferred: withUnresolvedThreadsPublish(deferral) } }
              : {}),
          });
        if (settled.error) return createErrorResponse(`Could not settle the deferred row: ${settled.error}`, 503);
        if (storyOnReelRow && carried.error) {
          // Logged only once the reel's row really holds the story.
          const logError = await writeLogRow(supabase, storyRecordedOnReelRowLog(post.user_id, post_id, row.id, carried.error));
          if (logError) console.error("[process-post] could not log the story recorded on the reel's row:", logError);
        }
        // This settle may have been the one that made the post final, and this run returns
        // before Step 6, so it reports the post here. A post that was not processing was
        // already final (or changed by someone) before this, and was announced then.
        const finished = post.status === "processing"
          ? await finishDeferredPost(supabase, post, row.id, {
            // The degraded fallback must report a live story too, whichever row now holds it.
            results: storyOnReelRow
              ? [
                { platform: row.platform, status: "success", platform_post_url: storyOnReelRow.url },
                { platform: row.platform, status: "failed", error_message: abandon },
              ]
              : [{ platform: row.platform, status: "failed", error_message: abandon }, ...recordedStoryResults(carried.recorded)],
            hasSuccess: storyOnReelRow !== null || carried.recorded.length > 0,
            hasFailed: true,
          }, imageAttemptFence(deferral, row.response_data))
          : { finalStatus: post.status as string, notified: false };
        return createJsonResponse({ success: true, status: "failed", reason: abandon, post_status: finished.finalStatus, notified: finished.notified });
      }
      resumeResponseData = { ...((row.response_data as Record<string, unknown> | null) ?? {}), deferred: deferral };
      resume = {
        platformPostId: row.id,
        deferral,
        unrecordedStory: readUnrecordedStory(row.response_data),
        accountUpdatedAt: typeof resumeResponseData?.account_updated_at === "string" ? resumeResponseData.account_updated_at : null,
        checkpointContainer: async (next) => {
          const previous = resume?.deferral.container_id;
          if (!previous) throw new Error("Missing deferred container checkpoint");
          const responseData = { ...resumeResponseData, deferred: next };
          const { data: changed, error: checkpointError } = await supabase
            .from("platform_posts")
            .update({ response_data: responseData })
            .eq("id", row.id)
            .eq("status", "pending")
            .eq("response_data->deferred->>container_id", previous)
            .select("id");
          if (checkpointError || changed?.length !== 1) throw new Error("Could not checkpoint the Threads carousel; nothing was published");
          resumeResponseData = responseData;
          if (resume) resume.deferral = next;
        },
        // Compare-and-set: only a pending row no run has marked yet, and it says whether it did.
        markFollowUpsStarted: async () => {
          const { data: marked, error: markError } = await supabase
            .from("platform_posts")
            .update({ response_data: withFollowUpsStarted(resumeResponseData ?? row.response_data, new Date()) })
            .eq("id", row.id)
            .eq("status", "pending")
            .is("response_data->deferred->>followups_started_at", null)
            .select("id");
          return markError ? { error: markError.message } : { claimed: (marked ?? []).length > 0 };
        },
      };
      if (resume.deferral.media_type === "IMAGE") {
        Object.assign(resume, threadsImageExecutionCallbacks(
          supabase,
          post,
          resume,
          resumeResponseData ?? row.response_data ?? {},
          (next) => { resumeResponseData = next; },
        ));
      }
      overrideAccountIds = [row.social_account_id];
      overridePlatforms = [row.platform];
      console.log("Resuming deferred publish", { post_id, platform_post_id: row.id, kind: deferral.kind, attempts: deferral.attempts });
    }
    const timing: PublishTiming = { resume, deadlineMs: pollDeadline(requestStartedAt, !!resume), startedAtMs: requestStartedAt };
    const retryRequest = resume ? null : activeRetryRequest(post);
    if (retryRequest) {
      overridePlatforms ??= retryRequest.platforms;
      overrideAccountIds ??= retryRequest.accountIds;
    }
    const retryRun = isRetryRun(post.status, !!resume) || retryRequest !== null;

    // The transition to `processing` is a CLAIM: when the scheduler says
    // which scheduled_at it selected, a row that no longer carries it -- the
    // partner or the UI unscheduled or moved it after the cron's SELECT --
    // matches nothing, and this publish is declined before any provider is
    // touched. Callers with no expectation keep the unconditional transition.
    // A resumed run continues the original run's claim; claiming again would also
    // restart the stale-post clock.
    const claim = resume ? { claimed: true, error: null, processingStartedAt: null } : await claimPostForProcessing(supabase, post_id, expectedScheduledAt, expectedPublishRequestedAt);
    if (claim.error) {
      const logError = await writeLogRow(supabase, {
        level: "error", category: "post", source: "process-post", user_id: post.user_id,
        message: "Post processing claim was refused or unavailable; no provider call was made",
        metadata: { event: "post_processing_claim_refused", post_id },
      });
      if (logError) console.error("Post processing claim refusal log failed:", logError);
      return createErrorResponse(`Could not claim post for processing: ${claim.error}`, 500);
    }
    if (!claim.claimed) {
      console.log("Declining publish: the post was rescheduled, or another scheduler run already claimed it", {
        post_id,
        expected_scheduled_at: expectedScheduledAt,
        expected_publish_requested_at: expectedPublishRequestedAt,
      });
      // Best effort: a failed log write must never replace the 409 the scheduler skips on.
      try {
        const { error: logError } = await supabase.from("system_logs").insert({
          level: "info",
          category: "post",
          source: "process-post",
          message: "Publish declined: post was rescheduled or already claimed by another scheduler run",
          user_id: post.user_id,
          metadata: {
            event: "claim_declined",
            post_id,
            expected_scheduled_at: expectedScheduledAt ?? null,
            expected_publish_requested_at: expectedPublishRequestedAt ?? null,
          },
        });
        if (logError) console.error("claim_declined log insert failed:", logError.message);
      } catch (e) {
        console.error("claim_declined log insert threw:", e instanceof Error ? e.message : String(e));
      }
      return createErrorResponse("Post was rescheduled or is already being processed; not published", 409);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 2: Get social accounts for selected platforms
    // Use override values if provided (for single-platform retry), else use post data
    // Determine which platforms to post to
    const platformsToPost: string[] = (overridePlatforms && Array.isArray(overridePlatforms) && overridePlatforms.length > 0)
      ? overridePlatforms
      : post.platforms;

    console.log("Platforms to post:", platformsToPost);

    // Guard: if no platforms, fail fast (prevents "completed" posts with no results)
    if (!Array.isArray(platformsToPost) || platformsToPost.length === 0) {
      const msg = "No platforms selected for this post";
      console.error(msg, { postId: post_id, overridePlatforms });
      await supabase.from("posts").update({ status: "failed" }).eq("id", post_id);
      return createErrorResponse(msg, 400);
    }

    // Determine which account IDs to use
    let selectedAccountIds: string[] = [];

    if (overrideAccountIds && Array.isArray(overrideAccountIds) && overrideAccountIds.length > 0) {
      // Use override account IDs (for single-platform retry)
      selectedAccountIds = overrideAccountIds.filter(
        (id: unknown): id is string => typeof id === "string" && id.length > 0
      );
      console.log("Using override account IDs:", selectedAccountIds);
    } else if (Array.isArray(post.metadata?.selected_account_ids)) {
      // Use post metadata account IDs
      selectedAccountIds = post.metadata!.selected_account_ids.filter(
        (id: unknown): id is string => typeof id === "string" && id.length > 0
      );
      console.log("Using post metadata account IDs:", selectedAccountIds);
    }

    let accountsQuery = supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", post.user_id)
      .in("platform", platformsToPost)
      .eq("is_active", true);

    if (selectedAccountIds.length > 0) {
      console.log("Filtering social accounts by selected IDs:", selectedAccountIds);
      accountsQuery = accountsQuery.in("id", selectedAccountIds);
    }

    const { data: accounts, error: accountsError } = await accountsQuery;

    if (accountsError) {
      throw accountsError;
    }

    console.log("Found accounts:", accounts?.length || 0);

    // Guard: if no accounts found, fail fast (prevents blank Profile/Account/Link in History)
    if (!accounts || accounts.length === 0) {
      const msg = selectedAccountIds.length > 0
        ? "No active social accounts found for the selected account IDs"
        : "No active social accounts found for the selected platforms";
      console.error(msg, { postId: post_id, platformsToPost, selectedAccountIds });
      if (resume) {
        const logError = await writeLogRow(supabase, {
          level: "error", category: "post", source: "process-post", user_id: post.user_id,
          message: "Deferred account scope was unavailable; pending state retained",
          metadata: { event: "deferred_account_refused", post_id, platform_post_id: resume.platformPostId },
        });
        if (logError) console.error("Deferred account refusal log failed:", logError);
        return createErrorResponse("The deferred account is no longer active or owned by this post owner. Retry reconciliation after restoring access.", 503);
      }
      await supabase.from("posts").update({ status: "failed" }).eq("id", post_id);
      return createErrorResponse(msg, 400);
    }

    const restoreUnpublishedClaim = async (): Promise<boolean> => {
      if (!claim.processingStartedAt) return true;
      const { data: restored, error: restoreError } = await supabase.from("posts")
        .update({ status: post.status }).eq("id", post_id).eq("status", "processing")
        .eq("processing_started_at", claim.processingStartedAt).select("id");
      if (!restoreError && (restored ?? []).length === 1) return true;
      await writeLogRow(supabase, {
        level: "error", category: "post", source: "process-post", user_id: post.user_id,
        message: "Unpublished processing claim could not be restored; current state retained",
        metadata: { event: "unpublished_claim_restore_failed", post_id, processing_started_at: claim.processingStartedAt },
      });
      return false;
    };

    // A direct override must not bypass the uncertain-image retry exclusion used
    // by SQL and n8n/MCP. Proven failures on other accounts remain eligible.
    if (!resume && accounts.some((account) => account.platform === "threads")) {
      const threadAccountIds = accounts.filter((account) => account.platform === "threads").map((account) => account.id);
      const { data: failedThreads, error: failedThreadsError } = await supabase
        .from("platform_posts")
        .select("social_account_id, response_data")
        .eq("post_id", post_id)
        .eq("platform", "threads")
        .eq("status", "failed")
        .in("social_account_id", threadAccountIds);
      const blocked = new Set<string>();
      if (!failedThreadsError) {
        for (const row of failedThreads ?? []) {
          const deferred = (row.response_data as { deferred?: Record<string, unknown> } | null)?.deferred;
          if (deferred?.media_type === "IMAGE" && deferred.publish_outcome === "uncertain" && row.social_account_id) {
            blocked.add(row.social_account_id);
          }
        }
      }
      const refuseRetry = async (message: string, statusCode: number) => {
        const logError = await writeLogRow(supabase, {
          level: "error", category: "post", source: "process-post", user_id: post.user_id,
          message: "Threads image retry refused without provider work or result deletion",
          metadata: { event: "threads_uncertain_retry_refused", post_id, account_ids: [...blocked], detail: message },
        });
        if (logError) console.error("Threads uncertain-retry refusal log failed:", logError);
        if (!await restoreUnpublishedClaim()) {
          return createErrorResponse("Threads image retry was refused and the prior parent state could not be restored. Current state was not replaced intentionally.", 503);
        }
        return createErrorResponse(message, statusCode);
      };
      if (failedThreadsError) {
        return await refuseRetry("Could not verify whether this Threads result is safe to retry. No publish was started.", 503);
      }
      if (blocked.size > 0 && accounts.every((account) => blocked.has(account.id))) {
        return await refuseRetry("Threads publish outcome is uncertain. Manual reconciliation is required before any retry.", 409);
      }
      if (blocked.size > 0) {
        accounts.splice(0, accounts.length, ...accounts.filter((account) => !blocked.has(account.id)));
      }
    }

    let retainedPlatformPostIds: string[] = [];
    if (!resume) {
      const { data: priorSuccesses, error: priorSuccessesError } = await supabase
        .from("platform_posts")
        .select("id, social_account_id, platform")
        .eq("post_id", post_id)
        .eq("status", "success");
      if (priorSuccessesError) {
        await writeLogRow(supabase, {
          level: "error", category: "post", source: "process-post", user_id: post.user_id,
          message: "Prior successful publications could not be read; no provider work started",
          metadata: { event: "prior_publication_read_failed", post_id },
        });
        const restored = await restoreUnpublishedClaim();
        return createErrorResponse(restored
          ? "Could not verify prior successful platform posts for retry safety. Prior state restored."
          : "Could not verify prior successful platform posts or restore the processing claim. Current state retained.", 503);
      }
      retainedPlatformPostIds = (priorSuccesses ?? [])
        .filter((r: { id?: string | null; social_account_id?: string | null; platform?: string | null }) =>
          typeof r.id === "string" &&
          typeof r.social_account_id === "string" &&
          (!accounts.some((a) => a.id === r.social_account_id) || (retryRun && r.platform === "instagram"))
        )
        .map((r: { id: string }) => r.id);
    }

    let enrolledCandidateId: string | null = null;
    let requiresImageFanoutClosure = false;
    if (!resume && claim.processingStartedAt) {
      try {
        const { data: enrollData, error: enrollError } = await supabase.rpc("enroll_post_notification_recovery", {
          p_post_id: post_id,
          p_expected_processing_started_at: claim.processingStartedAt,
          p_expected_content: threadsImageContentFence(post),
          p_target_account_ids: accounts.map((a) => a.id),
          p_retained_platform_post_ids: retainedPlatformPostIds,
        });
        if (enrollError) {
          console.warn("[process-post] enroll_post_notification_recovery RPC error:", enrollError);
        } else {
          const res = enrollData as { enrolled?: boolean; candidate_id?: string; requires_image_fanout_closure?: boolean } | null;
          if (res?.enrolled && typeof res.requires_image_fanout_closure === "boolean") {
            enrolledCandidateId = typeof res.candidate_id === "string" ? res.candidate_id : null;
            requiresImageFanoutClosure = res.requires_image_fanout_closure;
          }
        }
      } catch (enrollErr) {
        console.warn("[process-post] enroll_post_notification_recovery failed:", enrollErr);
      }
      if (!enrolledCandidateId) {
        await writeLogRow(supabase, { level: "error", category: "post", source: "process-post", user_id: post.user_id, message: "Publication stopped before provider execution because notification enrollment was unconfirmed", metadata: { event: "notification_enrollment_unconfirmed", post_id } });
        const restored = await restoreUnpublishedClaim();
        return createErrorResponse(restored
          ? "Publication admission could not be confirmed; prior state restored without provider work"
          : "Publication admission and prior state restoration could not be confirmed; no provider operation was started", 503);
      }
    }

    const failMediaPreparation = async (message: string, statusCode = 503) => {
      let resultWriteError: string | null = null;
      const failedRowIds: string[] = [];
      if (!resume) {
        for (const account of accounts) {
          const settled = await settlePlatformPost(supabase, {
            platformPostId: null, postId: post_id,
            socialAccountId: account.id, platform: account.platform,
            status: "failed", errorMessage: message,
          });
          if (settled.error) {
            resultWriteError = settled.error;
            console.error("Could not record media preparation retry target:", settled.error);
          }
          if (settled.id) failedRowIds.push(settled.id);
          else resultWriteError = resultWriteError ?? "Failed result identity unavailable";
        }
        if (!resultWriteError && enrolledCandidateId && claim.processingStartedAt) {
          const { data: closed, error: closeError } = await supabase.rpc("close_post_fanout", {
            p_post_id: post_id, p_expected_processing_started_at: claim.processingStartedAt,
            p_expected_content: threadsImageContentFence(post), p_exact_platform_post_ids: failedRowIds,
            p_retained_platform_post_ids: retainedPlatformPostIds,
          });
          if (closeError || closed?.closed !== true) resultWriteError = "Media failure completion could not be confirmed";
          else if (closed.ready === true) await announceFinalPost(supabase, post, closed.status, [], true);
        }
      }
      // The settlement seam owns final rollup; incomplete target recording must remain sweepable.
      const { error: statusError } = resultWriteError
        ? await supabase.from("posts").update({ status: "processing" }).eq("id", post_id)
          .eq("status", "processing").eq("processing_started_at", claim.processingStartedAt)
        : { error: null };
      if (statusError) console.error("Could not preserve incomplete retry-target recording:", statusError.message);
      const { error: logError } = await supabase.from("system_logs").insert({
        level: "error",
        category: "post",
        source: "process-post",
        message,
        user_id: post.user_id,
        metadata: {
          event: "media_preparation_failed", post_id,
          status_update_failed: Boolean(statusError),
          result_write_failed: Boolean(resultWriteError),
          resume_platform_post_id: resume?.platformPostId ?? null,
        },
      });
      if (logError) console.error("Could not log media preparation failure:", logError.message);
      return createErrorResponse(message, statusError || resultWriteError ? 500 : resume ? 503 : statusCode);
    };

    // ─────────────────────────────────────────────────────────────────────
    // Step 3: Get media files and generate URLs
    // ─────────────────────────────────────────────────────────────────────
    let mediaFiles: MediaFile[] = [];
    if (post.media_file_ids && post.media_file_ids.length > 0) {
      const { data: files, error: mediaReadError } = await supabase
        .from("media_files")
        .select("*")
        .in("id", post.media_file_ids);
      if (mediaReadError) {
        console.error("Could not read post media:", mediaReadError.message);
        return await failMediaPreparation("Could not read post media. Retry the publish.");
      }

      mediaFiles = orderPostMediaFiles(post.media_file_ids, files ?? []);
      console.log("Media files:", mediaFiles.length);

      const missingMediaFileIds = getMissingMediaFileIds(post.media_file_ids, mediaFiles);
      if (missingMediaFileIds.length > 0) {
        const message = `Post media is unavailable. Re-upload all ${post.media_file_ids.length} media item(s) before retrying.`;
        console.error(message, { postId: post_id, missingMediaFileIds });
        return await failMediaPreparation(message, 422);
      }

      // The scan-state rule is enforced HERE, at the publish, not only when
      // the post was created: a file marked `rejected` after creation must
      // not reach a provider. Same shared rule as POST /v1/messages and
      // POST /v1/posts (partnerMediaStore.mediaSendability); every row is
      // `available` today because nothing sets another state yet.
      const unsendable = mediaFiles.filter((file) =>
        !mediaSendability({ scanState: (file as { scan_state?: string | null }).scan_state ?? "available" }).ok
      );
      if (unsendable.length > 0) {
        const message = `Post media cannot be published: ${unsendable.length} file(s) are pending or rejected by scanning.`;
        console.error(message, { postId: post_id, mediaFileIds: unsendable.map((file) => file.id) });
        return await failMediaPreparation(message, 422);
      }
    }

    // Generate URLs for media files (provider-aware: prefer the delivery URL of the
    // read-preference provider, fall back to the other provider, then legacy paths).
    const mediaUrls: string[] = [];
    const providerPreferenceOrder = await cdnReadPreferenceOrder(supabase);

    // Provider state per media file (single query for the whole post). Rows are
    // matched against each file's current_object_version afterwards — renames bump
    // the version, and the stale version-1 rows stay 'ready' with dead URLs.
    const providerRowsByMedia = await loadMediaProviderRows(supabase, mediaFiles);

    for (const file of mediaFiles) {
      let resolvedUrl: string | null = null;
      try {
        resolvedUrl = await resolveMediaUrl(supabase, file, providerRowsByMedia, providerPreferenceOrder);
      } catch (signingError) {
        console.error(`Failed to create a delivery URL for media ${file.id}:`, redactProviderText(signingError));
        return await failMediaPreparation("Could not create a delivery URL for post media. Retry the publish.");
      }
      if (!resolvedUrl) {
        console.error(`No delivery URL could be resolved for media ${file.id}`);
        return await failMediaPreparation("Could not create a delivery URL for post media. Retry the publish.");
      }
      mediaUrls.push(resolvedUrl);
    }

    // ─────────────────────────────────────────────────────────────────────



    // ─────────────────────────────────────────────────────────────────────
    // Step 3.5: JIT Token Refresh for YouTube
    // YouTube tokens expire every hour. Refresh inline before posting.
    // ─────────────────────────────────────────────────────────────────────
    const postSource = (post as any).source || 'frontend';
    console.log(`[JIT] Checking YouTube tokens for post ${post_id} (source: ${postSource}, platforms: ${post.platforms?.join(',')})`);

    for (const account of (accounts || [])) {
      if (account.platform !== 'youtube' || account.auth_provider === 'composio') continue;

      // The refresh is ONE rule, shared with the continuation: a token that
      // expires within half an hour is refreshed before the provider is
      // contacted.
      const token = await refreshYoutubeAccessToken({
        supabase,
        account: {
          id: account.id,
          accessToken: account.access_token ?? null,
          refreshToken: account.refresh_token ?? null,
          tokenExpiresAt: account.token_expires_at ?? null,
        },
      });

      if (token.refreshed) {
        // Update in-memory so postToYouTube() uses the fresh token
        (account as any).access_token = token.accessToken;
        (account as any).token_expires_at = token.expiresAt;

        console.log(`[JIT] YouTube token refreshed for account ${account.id}, expires: ${token.expiresAt} (source: ${postSource}, post: ${post_id})`);

        // Write to system_logs for observability
        await supabase.from('system_logs').insert({
          level: 'info',
          category: 'token',
          source: 'process-post-jit',
          message: `YouTube token refreshed via JIT (source: ${postSource})`,
          user_id: post.user_id,
          metadata: {
            event: 'jit_refresh_success',
            platform: 'youtube',
            account_id: account.id,
            post_id: post_id,
            post_source: postSource,
            new_expires_at: token.expiresAt,
          },
        });
        continue;
      }

      if (!token.reason) continue;

      console.warn(`[JIT] The YouTube token of account ${account.id} was not refreshed (${token.reason}) (source: ${postSource}, post: ${post_id})`);

      await supabase.from('system_logs').insert({
        level: 'error',
        category: 'token',
        source: 'process-post-jit',
        message: `YouTube JIT token refresh failed (source: ${postSource})`,
        user_id: post.user_id,
        metadata: {
          event: 'jit_refresh_failed',
          platform: 'youtube',
          account_id: account.id,
          post_id: post_id,
          post_source: postSource,
          error: token.reason,
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 4: Post to each platform
    // ─────────────────────────────────────────────────────────────────────
    let hasSuccess = false;
    let hasFailed = false;
    // An account whose Meta container is left for reconcile-deferred-publishes.
    let hasDeferred = false;
    const managedImageFence = claim.processingStartedAt
      ? { processingStartedAt: claim.processingStartedAt, content: threadsImageContentFence(post) }
      : null;
    let imageHandoff: { processingStartedAt: string; content: Record<string, unknown> } | null = null;
    const platformResults: PlatformResultSummary[] = [];
    const exactPlatformPostIds: string[] = [];
    let fanoutWriteFailed = false;

    for (const account of (accounts || [])) {
      console.log(`Posting to ${account.platform}...`);
      // Stories this account published. They are live whatever the reel after them does and
      // whether or not their row was written, so they count in the roll-up and the notifications
      // (below); only the ones whose row was written may be dropped from a pending row's carry.
      const stories = newStoryLedger();
      const timingForAccount = accountTiming(timing, Date.now(), WORKER_STARTED_AT_MS);
      let imageExecution: ResumeContext | null = resume?.deferral.media_type === "IMAGE" ? resume : null;
      let imageResponseData: Record<string, unknown> | null = imageExecution ? resumeResponseData : null;
      let imageOutcomeAcknowledged = false;

      try {
        let result: PlatformPostResult;
        let independentStory = false;

        // Dispatch to platform-specific handler (alphabetical order)
        switch (account.platform) {
          case "bluesky":
            result = await postToBluesky(account, post, mediaUrls, supabase);
            break;
          case "facebook":
            result = await postToFacebook(account, post, mediaUrls, mediaFiles);
            break;
          case "instagram": {
            const primaryIsVideo = mediaFiles.length > 0
              ? (mediaFiles[0].file_type || (mediaFiles[0].mime_type?.startsWith("video/") ? "video" : "image")) === "video"
              : isVideoUrl(mediaUrls[0]);
            const primaryPost = await prepareIndependentStory(post, account.id, primaryIsVideo, async (postId, accountId, userId) => {
              const { data, error } = await supabase.rpc("prepare_instagram_story", {
                p_post_id: postId, p_account_id: accountId, p_user_id: userId,
              });
              if (error) throw new Error("story_intent_unavailable");
              return data === true;
            });
            independentStory = primaryPost !== post;
            const igAuthType = (account as any).ig_auth_type || (account.account_metadata as Record<string, unknown>)?.account_type;
            const recorded = retryRun ? await recordedOnRetry(supabase, post_id, account.id) : null;
            const retry: RetryState = recorded
              ? {
                storyRecorded: recorded.story,
                feedRecorded: recorded.feed,
                recordedMediaIds: (ids) => recordedMediaIdsFor(supabase, post_id, account.id, ids),
              }
              : NOT_A_RETRY;
            if (igAuthType === 'business_login') {
              result = await postToInstagramBusinessLogin(account, primaryPost, mediaUrls, mediaFiles, supabase, post_id, timingForAccount, retry, (id) => {
                if (id) exactPlatformPostIds.push(id);
                else fanoutWriteFailed = true;
              });
            } else {
              result = await postToInstagram(account, primaryPost, mediaUrls, mediaFiles, timingForAccount, (story) =>
                recordLiveStory(supabase, { postId: post_id, account, story, onRecorded: (id) => exactPlatformPostIds.push(id) }, stories), retry, async (error) => {
                const settled = await settlePlatformPost(supabase, {
                  platformPostId: null,
                  postId: post_id,
                  socialAccountId: account.id,
                  platform: "instagram",
                  status: "failed",
                  errorMessage: error,
                  responseData: { ig_post_subtype: "story", account_username: account.platform_username },
                });
                if (settled.id) exactPlatformPostIds.push(settled.id);
                if (settled.error || !settled.id) fanoutWriteFailed = true;
                return settled.error;
              });
            }
            break;
          }
          case "linkedin":
            result = await postToLinkedIn(account, post, mediaUrls);
            break;
          case "pinterest":
            result = await postToPinterest(account, post, mediaUrls, supabase, claim.processingStartedAt);
            break;
          case "reddit":
            result = await postToReddit(account, post, mediaUrls);
            break;
          case "threads": {
            const imageCheckpoint: ThreadsImageCheckpoint = async (deferral) => {
              if (!claim.processingStartedAt) throw new ThreadsCheckpointUnavailable("Threads image claim fence unavailable");
              if (managedImageFence) imageHandoff = managedImageFence;
              const expectedContent = threadsImageContentFence(post);
              const responseData = {
                deferred: deferral,
                account_username: account.platform_username,
                account_metadata: account.account_metadata,
                account_updated_at: (account as SocialAccount & { updated_at?: string | null }).updated_at ?? null,
                content_fence: expectedContent,
              };
              const { data, error } = await supabase.rpc("record_threads_image_checkpoint", {
                p_post_id: post_id,
                p_social_account_id: account.id,
                p_response_data: responseData,
                p_expected_processing_started_at: claim.processingStartedAt,
                p_expected_content: expectedContent,
                p_target_account_ids: accounts.map((a) => a.id),
                p_retained_platform_post_ids: retainedPlatformPostIds,
              });
              if (error || typeof data !== "string" || !data) {
                if (error && (
                  error.message?.includes("is in status failed") ||
                  error.message?.includes("is in status canceled") ||
                  error.message?.includes("cancelled or retried attempt")
                )) {
                  throw new ThreadsCheckpointCanceled(error.message || "Threads image checkpoint refused: parent state changed or canceled");
                }
                throw new ThreadsCheckpointUnavailable("Threads image checkpoint could not be confirmed");
              }
              exactPlatformPostIds.push(data);
              const executionId = crypto.randomUUID();
              const { data: claimed, error: inlineClaimError } = await supabase.rpc("claim_threads_image_inline_execution", {
                p_platform_post_id: data,
                p_post_id: post_id,
                p_social_account_id: account.id,
                p_expected_container_id: deferral.container_id,
                p_expected_processing_started_at: claim.processingStartedAt,
                p_expected_content: expectedContent,
                p_execution_id: executionId,
              });
              if (inlineClaimError) {
                const logError = await writeLogRow(supabase, {
                  level: "error", category: "post", source: "process-post", user_id: post.user_id,
                  message: "Threads image inline claim was not acknowledged; no status or publish call was made",
                  metadata: { event: "threads_image_inline_claim_unavailable", post_id, platform_post_id: data },
                });
                if (logError) console.error("Threads image inline claim refusal log failed:", logError);
                throw new ThreadsCheckpointUnavailable("Threads image inline execution claim could not be confirmed");
              }
              if (claimed === null) {
                const logError = await writeLogRow(supabase, {
                  level: "info", category: "post", source: "process-post", user_id: post.user_id,
                  message: "Threads image inline execution was refused; the durable checkpoint remains for reconciliation",
                  metadata: { event: "threads_image_inline_claim_refused", post_id, platform_post_id: data },
                });
                if (logError) console.error("Threads image inline claim refusal log failed:", logError);
                return { platformPostId: data, responseData, execution: null };
              }
              const claimedData = claimed as { platform_post_id?: unknown; response_data?: unknown } | null;
              const authoritativeData = claimedData?.response_data &&
                  typeof claimedData.response_data === "object" && !Array.isArray(claimedData.response_data)
                ? claimedData.response_data as Record<string, unknown>
                : null;
              const authoritativeDeferral = readDeferral(authoritativeData);
              if (claimedData?.platform_post_id !== data || !authoritativeData || !authoritativeDeferral ||
                authoritativeDeferral.container_id !== deferral.container_id ||
                authoritativeDeferral.attempt_started_at !== claim.processingStartedAt ||
                authoritativeDeferral.execution_id !== executionId ||
                !authoritativeDeferral.execution_claimed_until ||
                authoritativeDeferral.claimed_until !== authoritativeDeferral.execution_claimed_until ||
                authoritativeDeferral.publish_attempt_id) {
                throw new ThreadsCheckpointUnavailable("Threads image inline claim returned no authoritative executable state");
              }
              const execution: ResumeContext = {
                platformPostId: data,
                deferral: authoritativeDeferral,
                inline: true,
                accountUpdatedAt: typeof authoritativeData.account_updated_at === "string" ? authoritativeData.account_updated_at : null,
              };
              Object.assign(execution, threadsImageExecutionCallbacks(
                supabase,
                post,
                execution,
                authoritativeData,
                (next) => { imageResponseData = next; },
              ));
              imageExecution = execution;
              imageResponseData = authoritativeData;
              imageHandoff = { processingStartedAt: claim.processingStartedAt, content: expectedContent };
              return { platformPostId: data, responseData: authoritativeData, execution };
            };
            result = await postToThreads(account, post, mediaUrls, timingForAccount, imageCheckpoint, claim.processingStartedAt);
            break;
          }
          case "tiktok": {
            const reviewSubmissionId = requiredReviewSubmissionId(post);
            result = reviewSubmissionId
              ? await postToTikTok(account, post, mediaUrls, (publishId) =>
                recordReviewPublishId(supabase, {
                  submissionId: reviewSubmissionId, postId: post.id, userId: post.user_id, publishId,
                }))
              : await postToTikTok(account, post, mediaUrls);
            break;
          }
          case "twitter":
            result = await postToTwitter(account, post, mediaUrls, supabase);
            break;
          case "youtube": {
            if (account.auth_provider === "composio") {
              result = await publishYouTubeViaComposio(account, post, mediaFiles, {
                admin: supabase,
                client: composioClientFromEnv(),
                signedUrlFor: async (file) => {
                  const { data, error } = await supabase.storage
                    .from(file.storage_bucket)
                    .createSignedUrl(file.file_path, 3600);
                  if (error || !data?.signedUrl) throw new Error("youtube_media_sign_failed");
                  return data.signedUrl;
                },
              });
              break;
            }
            // The native YouTube path admits the upload BEFORE the provider is
            // contacted.
            //
            // The admission creates the private session AND the public pending
            // platform_posts row in one transaction. That is what closes the
            // window where a post had a pending row that no continuation
            // could claim, and it is what the sweeper respects while the
            // upload is in flight: the post is never declared "safe to
            // retry" while the provider may already hold a video.
            //
            // The resolved targets of this run are handed over, so the
            // continuation knows the account was really targeted and not
            // merely owned by the customer.
            const resolvedTargetAccountIds = (accounts ?? []).map((entry) => entry.id);
            result = await postToYouTube(
              account,
              post,
              mediaUrls,
              mediaFiles,
              supabase,
              claim.processingStartedAt ?? null,
              resolvedTargetAccountIds,
            );
            break;
          }
          default:
            throw new Error(`Unsupported platform: ${account.platform}`);
        }

        imageOutcomeAcknowledged = imageExecution?.deferral.media_type === "IMAGE";
        if (result.deferredHandoff) {
          platformResults.push({ platform: account.platform, status: "pending" });
          hasDeferred = true;
          if (!claim.processingStartedAt) throw new ThreadsCheckpointUnavailable("Threads image handoff claim fence unavailable");
          imageHandoff = { processingStartedAt: claim.processingStartedAt, content: threadsImageContentFence(post) };
          console.log(`[threads] image checkpoint ${result.deferredHandoff.platformPostId} left for the reconciler`);
          continue;
        }

        if (result.pendingContinuation) {
          // The upload continues in a later worker. The row stays pending and
          // the post stays processing, so the sweeper leaves it alone and the
          // continuation settles it when the video is there.
          platformResults.push({ platform: account.platform, status: "pending" });
          hasDeferred = true;
          if (result.pendingPlatformPostId) exactPlatformPostIds.push(result.pendingPlatformPostId);
          console.log(`[${account.platform}] upload left for the continuation`);
          continue;
        }

        // If the platform handler already wrote its own platform_posts rows
        // (e.g. Instagram fan-out into story/reel/feed), skip the default insert.
        if (result.selfWroteRows) {
          const subResults = result.subResults || [];
          for (const sub of subResults) {
            // Provider IDs are not platform_posts primary keys.
            platformResults.push({
              platform: account.platform,
              status: sub.status,
              platform_post_url: sub.url,
              error_message: sub.error,
            });
            if (sub.status === "success") hasSuccess = true;
            else hasFailed = true;
          }
          console.log(`[${account.platform}] handler wrote ${subResults.length} rows itself (selfWroteRows)`);
          continue;
        }

        // Determine status - TikTok uses pending when video is still processing (no URL yet)
        const isTikTokProcessing = account.platform === "tiktok" && result.id && !result.url;
        // Use "pending" for TikTok processing status (constraint only allows: pending, success, failed)
        const resultStatus = isTikTokProcessing ? "pending" : "success";

        // Save result to platform_posts
        const warnings = (result as any).warnings || [];
        const locationDebug = (result as any).location_debug;
        const topicTagDebug = (result as any).topic_tag_debug;
        const unrecordedStoryRef = (result as { unrecorded_story?: StoryRef }).unrecorded_story;
        if (unrecordedStoryRef) {
          const logError = await writeLogRow(supabase, liveReelUnrecordedStoryLog(post.user_id, post_id, resume?.platformPostId ?? null, unrecordedStoryRef));
          if (logError) console.error("[process-post] could not log the unrecorded story either:", logError);
        }
        const responseData = {
          ...(imageExecution?.deferral.media_type === "IMAGE" ? { ...imageResponseData, deferred: imageExecution.deferral } : {}),
          ...(independentStory && result.publicationSubtype === "reel" ? { ig_post_subtype: "reel" } : {}),
          tiktok_publish_id: result.id,
          account_username: account.platform_username,
          account_metadata: account.account_metadata,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(locationDebug ? { location_debug: locationDebug } : {}),
          ...(topicTagDebug ? { topic_tag_debug: topicTagDebug } : {}),
          ...(unrecordedStoryRef ? { [UNRECORDED_STORY_KEY]: unrecordedStoryRef } : {}),
        };

        // The one writer of the five that can produce a NON-terminal row:
        // TikTok hands back an id before the video is published, and that row
        // stays `pending` until the poller settles it. A pending row is not a
        // transition, so it must not emit -- it keeps the plain insert. Every
        // other outcome is terminal and goes through the seam.
        let platformPostRecord: { id: string } | null = null;
        if (resultStatus === "pending") {
          const { data, error: insertError } = await supabase.from("platform_posts").insert({
            post_id: post_id,
            social_account_id: account.id,
            platform: account.platform,
            platform_post_id: result.id,
            platform_post_url: result.url,
            status: resultStatus,
            posted_at: result.url ? new Date().toISOString() : null,
            response_data: responseData,
          }).select().single();
          if (insertError) {
            console.error(`Error inserting platform_posts record for ${account.platform}:`, insertError);
            throw new Error(`Failed to save platform post: ${insertError.message}`);
          }
          platformPostRecord = data;
        } else if (result.settledByUpload && result.pendingPlatformPostId) {
          // The YouTube upload settled its own public row, fenced to the
          // worker that owned the upload. The row is already terminal, so the
          // loop records it instead of settling it a second time.
          platformPostRecord = { id: result.pendingPlatformPostId };
        } else {
          const settled = await settlePlatformPost(supabase, {
            // A resumed run settles the pending row the first run left.
            platformPostId: imageExecution?.platformPostId ?? resume?.platformPostId ?? result.pendingPlatformPostId ?? null,
            postId: post_id,
            socialAccountId: account.id,
            platform: account.platform,
            status: resultStatus,
            providerPostId: result.providerPostId ?? result.id ?? null,
            providerPostUrl: result.url ?? null,
            responseData,
          });
          if (settled.error) {
            console.error(`Error settling platform_posts record for ${account.platform}:`, settled.error);
            throw new Error(`Failed to save platform post: ${settled.error}`);
          }
          platformPostRecord = settled.id ? { id: settled.id } : null;
        }

        if (platformPostRecord?.id) {
          exactPlatformPostIds.push(platformPostRecord.id);
        }

        console.log(`Saved platform_posts record for ${account.platform}: ${platformPostRecord?.id}`);

        // If TikTok is still processing, start background polling
        if (isTikTokProcessing && platformPostRecord && typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
          console.log(`TikTok: Starting background polling for publish_id: ${result.id}`);

          // Extract the actual TikTok username from account_metadata (the handle, not display name)
          const tiktokUsername = (account.account_metadata as any)?.tiktok_username ||
            (account.account_metadata as any)?.creator_username;

          EdgeRuntime.waitUntil(
            pollTikTokPublishStatus(
              result.id!,
              account.access_token,
              account.platform_username,
              platformPostRecord.id,
              post_id,
              supabase,
              tiktokUsername // Pass the actual TikTok handle
            )
          );
        }

        platformResults.push({
          platform: account.platform,
          status: resultStatus,
          platform_post_url: result.url,
        });

        hasSuccess = true;
        console.log(`Successfully posted to ${account.platform}${isTikTokProcessing ? " (processing in background)" : ""}`);

      } catch (caught) {
        if (imageOutcomeAcknowledged && imageExecution) {
          // Meta acknowledged publication (or reported PUBLISHED). A failed
          // success write cannot become a retryable publishing failure.
          const logError = await writeLogRow(supabase, {
            level: "error", category: "post", source: "process-post", user_id: post.user_id,
            message: "Threads image publication acknowledged but result recording was not confirmed; checkpoint retained",
            metadata: { event: "threads_image_success_unrecorded", post_id, platform_post_id: imageExecution.platformPostId },
          });
          if (logError) console.error("Threads image success-recording refusal log failed:", logError);
          if (accounts.length > 1 && !resumePlatformPostId) {
            const { data: currentPost, error: checkError } = await supabase
              .from("posts")
              .select("status, processing_started_at, user_id, caption, media_file_ids, metadata, platforms, scheduled_at, publish_requested_at, source")
              .eq("id", post_id)
              .maybeSingle();
            const contentOk = currentPost && await hashRequest(threadsImageContentFence(currentPost as PostData)) === await hashRequest(threadsImageContentFence(post));
            if (checkError || !currentPost || currentPost.status !== "processing" ||
                (claim.processingStartedAt && currentPost.processing_started_at !== claim.processingStartedAt) || !contentOk) {
              console.log("Parent post canceled, superseded, or content changed; stopping remaining fan-out");
              return createErrorResponse("Post processing was canceled or superseded. No further accounts published.", 409);
            }
            platformResults.push({ platform: account.platform, status: "pending" });
            hasDeferred = true;
            continue;
          }
          return createErrorResponse("Threads image publication was acknowledged but recording could not be confirmed. The existing checkpoint will be reconciled; do not retry publication.", 503);
        }
        if (caught instanceof ThreadsCheckpointUnavailable) {
          if (caught instanceof ThreadsCheckpointCanceled) {
            const logError = await writeLogRow(supabase, {
              level: "info", category: "post", source: "process-post", user_id: post.user_id,
              message: "Threads checkpoint refused because parent state was canceled or changed; remaining fan-out halted",
              metadata: { event: "threads_checkpoint_canceled", post_id },
            });
            if (logError) console.error("Threads checkpoint cancellation log failed:", logError);
            return createErrorResponse("Post processing was canceled or superseded. No further accounts published.", 409);
          }
          try {
            const { error: logError } = await supabase.from("system_logs").insert({
              level: "error", category: "post", source: "process-post", user_id: post.user_id,
              message: "Threads container checkpoint unavailable; no new publish was started and pending state was retained",
              metadata: { event: "threads_checkpoint_refused", post_id, platform_post_id: imageExecution?.platformPostId ?? resume?.platformPostId ?? null },
            });
            if (logError) console.error("Threads checkpoint refusal log failed");
          } catch {
            console.error("Threads checkpoint refusal log unavailable");
          }
          if (accounts.length > 1 && !resumePlatformPostId) {
            const { data: currentPost, error: checkError } = await supabase
              .from("posts")
              .select("status, processing_started_at, user_id, caption, media_file_ids, metadata, platforms, scheduled_at, publish_requested_at, source")
              .eq("id", post_id)
              .maybeSingle();
            const contentOk = currentPost && await hashRequest(threadsImageContentFence(currentPost as PostData)) === await hashRequest(threadsImageContentFence(post));
            if (checkError || !currentPost || currentPost.status !== "processing" ||
                (claim.processingStartedAt && currentPost.processing_started_at !== claim.processingStartedAt) || !contentOk) {
              console.log("Parent post canceled, superseded, or content changed; stopping remaining fan-out");
              return createErrorResponse("Post processing was canceled or superseded. No further accounts published.", 409);
            }
            platformResults.push({ platform: account.platform, status: "pending" });
            hasDeferred = true;
            continue;
          }
          return createErrorResponse("Threads container checkpoint could not be confirmed. No new publish was started; retry reconciliation shortly.", 503);
        }
        let error = caught;
        if (error instanceof ContainerStillProcessing) {
          const recorded = await recordStillProcessing(supabase, settlePlatformPost, {
            postId: post_id,
            account,
            signal: error,
            resume: imageExecution ?? resume,
            // A story whose row this very run wrote must not be carried (and recorded) again.
            resumeResponseData: dropRecordedStory(imageExecution ? imageResponseData : resumeResponseData, stories.recorded),
          });
          if (recorded.platformPostId) exactPlatformPostIds.push(recorded.platformPostId);
          if (!recorded.error && !recorded.gaveUp) {
            console.log(`[${account.platform}] container ${error.containerId} still processing; left for the reconciler`);
            platformResults.push({ platform: account.platform, status: "pending" });
            hasDeferred = true;
            continue;
          }
          if (!recorded.error) {
            platformResults.push({ platform: account.platform, status: "failed", error_message: imageExecution ?? resume ? deferralGiveUpMessage((imageExecution ?? resume)!.deferral) : giveUpMessage(error.kind) });
            hasFailed = true;
            continue;
          }
          console.error(`[${account.platform}] could not record the deferred container:`, recorded.error);
          if (imageExecution?.deferral.media_type === "IMAGE") {
            const logError = await writeLogRow(supabase, {
              level: "error", category: "post", source: "process-post", user_id: post.user_id,
              message: "Threads image execution update was not confirmed; pending state was not settled",
              metadata: { event: "threads_image_stale_execution", post_id, platform_post_id: imageExecution.platformPostId },
            });
            if (logError) console.error("Threads image stale-execution log failed:", logError);
            if (accounts.length > 1 && !resumePlatformPostId) {
              const { data: currentPost, error: checkError } = await supabase
                .from("posts")
                .select("status, processing_started_at, user_id, caption, media_file_ids, metadata, platforms, scheduled_at, publish_requested_at, source")
                .eq("id", post_id)
                .maybeSingle();
              const contentOk = currentPost && await hashRequest(threadsImageContentFence(currentPost as PostData)) === await hashRequest(threadsImageContentFence(post));
              if (checkError || !currentPost || currentPost.status !== "processing" ||
                  (claim.processingStartedAt && currentPost.processing_started_at !== claim.processingStartedAt) || !contentOk) {
                console.log("Parent post canceled, superseded, or content changed; stopping remaining fan-out");
                return createErrorResponse("Post processing was canceled or superseded. No further accounts published.", 409);
              }
              platformResults.push({ platform: account.platform, status: "pending" });
              hasDeferred = true;
              continue;
            }
            return createErrorResponse("Threads image reconciliation ownership changed or could not be confirmed. Retry shortly.", 503);
          }
          error = new Error(`${account.platform === "threads" ? "Threads" : "Instagram"} was still processing the media and it could not be finished later. Safe to retry.`);
        }
        console.error(`Error posting to ${account.platform}:`, error);

        // If the handler already wrote its own rows (selfWroteRows flag on the error),
        // do not insert a duplicate failed row.
        const selfWrote = (error as { selfWroteRows?: boolean })?.selfWroteRows === true;
        if (!selfWrote) {
          // An error that carries its own response data says what the row has
          // to hold: the uncertain marker of an upload that may already have
          // published. It wins over the deferred image data, which belongs to
          // another platform's rule and never travels with a YouTube failure.
          const ownedResponseData = (error as { responseData?: Record<string, unknown> })?.responseData ?? null;
          const settled = await settlePlatformPost(supabase, {
            platformPostId: imageExecution?.platformPostId ?? resume?.platformPostId ?? null,
            postId: post_id,
            socialAccountId: account.id,
            platform: account.platform,
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "Unknown error",
            ...(ownedResponseData
              ? { responseData: ownedResponseData }
              : imageExecution?.deferral.media_type === "IMAGE"
                ? { responseData: { ...imageResponseData, deferred: imageExecution.deferral } }
                : {}),
          });
          if (settled.id) {
            exactPlatformPostIds.push(settled.id);
          }
          if (settled.error || !settled.id) fanoutWriteFailed = true;
          if (settled.error) {
            console.error(`Failed to settle the failure row for ${account.platform}:`, settled.error);
          }
        } else {
          // The row the handler owns is part of the scope of this attempt, even
          // when the handler did not write the outcome itself: the closure
          // reads the scope, and a scope that names a destination without a
          // result row is refused. The fanout could then never close, and the
          // post would wait for ever.
          const ownedRowId = (error as { platformPostId?: string | null })?.platformPostId ?? null;
          if (ownedRowId) {
            exactPlatformPostIds.push(ownedRowId);
          }
        }

        platformResults.push({
          platform: account.platform,
          status: "failed",
          error_message: error instanceof Error ? error.message : "Unknown error",
        });

        hasFailed = true;
      } finally {
        // Runs for every outcome, `continue` included: a live story is a success.
        if (stories.live.length > 0) {
          platformResults.push(...recordedStoryResults(stories.live));
          hasSuccess = true;
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 5: Update post status and quotas
    // ─────────────────────────────────────────────────────────────────────
    let finalStatus = hasSuccess && !hasFailed ? "completed" : hasFailed && !hasSuccess ? "failed" : "completed";
    // Notifications go out once the post is final: here, or from the resumed run that settles it.
    let notify = true;

    // Track exact result IDs and close fanout if candidate enrolled
    const uniqueExactRowIds = Array.from(new Set(exactPlatformPostIds));
    type FanoutClosedOutcome = {
      closed?: boolean;
      ready?: boolean;
      status?: string;
      authorized_platform_post_ids?: string[];
    };
    let fanoutClosedResult: FanoutClosedOutcome | null = null;

    if (!resume && claim.processingStartedAt && enrolledCandidateId &&
        (!imageHandoff || requiresImageFanoutClosure || fanoutWriteFailed)) {
      if (fanoutWriteFailed) {
        await writeLogRow(supabase, { level: "error", category: "post", source: "process-post", user_id: post.user_id, message: "Complete notification scope unavailable after a result write failed", metadata: { event: "notification_fanout_write_failed", post_id } });
        return createErrorResponse("Existing provider results retained; result recording needs reconciliation", 503);
      }
      try {
        const { data: closeData, error: closeError } = await supabase.rpc("close_post_fanout", {
          p_post_id: post_id,
          p_expected_processing_started_at: claim.processingStartedAt,
          p_expected_content: threadsImageContentFence(post),
          p_exact_platform_post_ids: uniqueExactRowIds,
          p_retained_platform_post_ids: retainedPlatformPostIds,
        });
        if (closeError) {
          console.warn("[process-post] close_post_fanout RPC error:", closeError);
        } else {
          fanoutClosedResult = closeData as FanoutClosedOutcome;
          console.log("[process-post] close_post_fanout result:", fanoutClosedResult);
        }
      } catch (closeErr) {
        console.warn("[process-post] close_post_fanout failed:", closeErr);
      }
      if (!fanoutClosedResult?.closed) {
        await writeLogRow(supabase, { level: "error", category: "post", source: "process-post", user_id: post.user_id, message: "Publication results retained but the complete fanout could not be proven", metadata: { event: "notification_fanout_unconfirmed", post_id } });
        return createErrorResponse("Existing publication results retained; completion requires reconciliation", 503);
      }
    }

    if (resume) {
      // Legacy settlement rolled the post up; a managed image finalizes its fenced
      // attempt first. finishDeferredPost then reads the final state (retrying once;
      // an unreadable post is logged, not taken for unfinished) and, if it is final,
      // notifies for all of its accounts, not only this one.
      const finished = await finishDeferredPost(
        supabase,
        post,
        resume.platformPostId,
        { results: platformResults, hasSuccess, hasFailed },
        imageAttemptFence(resume.deferral, resumeResponseData),
      );
      finalStatus = finished.finalStatus;
      notify = false;
    } else if (imageHandoff) {
      // The original claim and content alone may roll up this first-run fan-out.
      // The same parent lock claims the one final notification after all siblings settle.
      notify = false;
      const { data: finalized, error: finalizationError } = await supabase.rpc("finalize_threads_image_attempt", {
        p_post_id: post_id,
        p_expected_processing_started_at: imageHandoff.processingStartedAt,
        p_expected_content: imageHandoff.content,
        p_expected_account_ids: accounts.map((a) => a.id),
      });
      const finalization = finalized as {
        status?: unknown;
        stale?: unknown;
        notify?: unknown;
        authorized_platform_post_ids?: unknown;
      } | null;
      if (finalizationError || typeof finalization?.status !== "string" ||
        typeof finalization.stale !== "boolean" || typeof finalization.notify !== "boolean") {
        const logError = await writeLogRow(supabase, {
          level: "error", category: "post", source: "process-post", user_id: post.user_id,
          message: "Threads image handoff could not confirm the current parent state; checkpoint retained",
          metadata: { event: "threads_image_handoff_state_unreadable", post_id },
        });
        if (logError) console.error("Threads image handoff state-read log failed:", logError);
        return createErrorResponse("Threads image handoff could not confirm the current parent state. Checkpoint retained.", 503);
      }
      finalStatus = finalization.status;
      if (finalization.stale) {
        const logError = await writeLogRow(supabase, {
          level: "info", category: "post", source: "process-post", user_id: post.user_id,
          message: "Threads image handoff preserved a newer parent state",
          metadata: { event: "threads_image_handoff_stale", post_id, current_status: finalStatus },
        });
        if (logError) console.error("Threads image handoff stale-state log failed:", logError);
      } else if (finalization.notify) {
        let authorizedPlatformPostIds: string[] | null = null;
        if (Array.isArray(finalization.authorized_platform_post_ids)) {
          authorizedPlatformPostIds = finalization.authorized_platform_post_ids.filter((id): id is string => typeof id === "string");
        }
        const outcome = await readPostOutcome(postReaderFor(supabase, authorizedPlatformPostIds ?? []), post_id, {
          results: platformResults,
          hasSuccess,
          hasFailed,
        });
        if (outcome.kind === "terminal" && !outcome.degraded) {
          await announceFinalPost(supabase, post, finalStatus, outcome.results, outcome.hasFailed, imageHandoff);
        } else {
          const degradedReason = outcome.kind === "terminal" ? outcome.degraded : outcome.kind === "unknown" ? outcome.error : "post still in progress";
          console.warn(`[process-post] withholding Threads image managed notification: ${degradedReason}`);
          await writeLogRow(supabase, {
            level: "error", category: "post", source: "process-post", user_id: post.user_id,
            message: "Threads image final notification withheld because authorized platform post rows could not be completely read",
            metadata: { event: "threads_image_notification_read_degraded", post_id, reason: degradedReason },
          });
        }
      }
    } else if (hasDeferred) {
      // Legacy video/carousel pending behavior is unchanged.
      finalStatus = "processing";
      notify = false;
      if (claim.processingStartedAt) {
        const { data: restoreResult, error: restoreError } = await supabase.rpc("restore_legacy_pending_post", {
          p_post_id: post_id,
          p_expected_processing_started_at: claim.processingStartedAt,
          p_expected_content: threadsImageContentFence(post),
          p_has_success: hasSuccess,
        });
        const res = restoreResult as {
          restored?: boolean;
          status?: string;
          prior_status?: string;
          reason?: string;
          current_status?: string;
          already_processing?: boolean;
        } | null;

        if (restoreError || !res || typeof res.restored !== "boolean" ||
          (!res.restored && typeof res.current_status !== "string")) {
          await writeLogRow(supabase, {
            level: "error", category: "post", source: "process-post", user_id: post.user_id,
            message: "Could not execute atomic restoration of processing status for sibling rollup",
            metadata: { event: "legacy_pending_rollup_read_failed", post_id, error: restoreError?.message ?? "RPC failed" },
          });
          return createErrorResponse("Deferred publication could not confirm its current parent state. Existing work is retained.", 503);
        } else if (res.restored) {
          finalStatus = "processing";
          if (!res.already_processing) {
            console.log(`Parent post status restored to processing from same-attempt sibling rollup (${res.prior_status})`);
          }
        } else {
          await writeLogRow(supabase, {
            level: "info", category: "post", source: "process-post", user_id: post.user_id,
            message: "Parent post status not restored to processing because parent state was canceled, superseded, or modified",
            metadata: {
              event: "legacy_pending_restore_skipped",
              post_id,
              current_status: res.current_status,
              reason: res.reason,
            },
          });
          finalStatus = res.current_status!;
          console.log("Parent status was canceled or modified; processing status not restored");
        }
      } else {
        await supabase
          .from("posts")
          .update({ status: "processing", posted_at: hasSuccess ? new Date().toISOString() : null })
          .eq("id", post_id);
      }
    } else {
      const closedRes = fanoutClosedResult as FanoutClosedOutcome | null;
      if (closedRes?.closed && closedRes.status) {
        finalStatus = closedRes.status;
      } else {
        await supabase
          .from("posts")
          .update({
            status: finalStatus,
            posted_at: hasSuccess ? new Date().toISOString() : null
          })
          .eq("id", post_id);
      }


    }

    console.log("Post processing complete:", finalStatus);

    // Quota is reserved on posts INSERT (enforce_post_quota_on_insert trigger).
    // Do not increment again here — that double-counted successful publishes.

    // ─────────────────────────────────────────────────────────────────────
    // Step 6: Send webhook notifications (non-blocking)
    // ─────────────────────────────────────────────────────────────────────
    if (notify) {
      await announceFinalPost(supabase, post, finalStatus, platformResults, hasFailed);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 7: Log to system_logs and return response
    // ─────────────────────────────────────────────────────────────────────
    // Log post processing result
    try {
      const platformList = platformResults.map(r => r.platform);
      const successPlatforms = platformResults.filter(r => r.status === 'success').map(r => r.platform);
      const failedPlatforms = platformResults.filter(r => r.status === 'failed').map(r => r.platform);

      await supabase.from('system_logs').insert({
        level: hasFailed && !hasSuccess ? 'error' : hasFailed ? 'warn' : 'info',
        category: 'post',
        source: 'process-post',
        message: (hasSuccess && !hasFailed
          ? `Post published successfully to ${successPlatforms.join(', ')}`
          : hasFailed && !hasSuccess
            ? `Post failed on all platforms: ${failedPlatforms.join(', ')}`
            : `Post partially succeeded: ${successPlatforms.join(', ')} succeeded, ${failedPlatforms.join(', ')} failed`)
          + (hasDeferred ? " (media is still processing and will be finished in the background)" : ""),
        user_id: post.user_id,
        metadata: {
          post_id: post_id,
          platforms: platformList,
          success_platforms: successPlatforms,
          failed_platforms: failedPlatforms,
          final_status: finalStatus,
          failed_details: platformResults
            .filter(r => r.status === 'failed')
            .map(r => ({ platform: r.platform, error: r.error_message })),
        },
      });
    } catch (logError) {
      console.error('Failed to log post event:', logError);
    }

    return createJsonResponse({
      success: true,
      status: finalStatus,
      hasSuccess,
      hasFailed,
      platform_results: platformResults,
    });

  } catch (error: unknown) {
    console.error("Process post error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse(message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: PLATFORM HANDLERS (Alphabetical Order)
// ═══════════════════════════════════════════════════════════════════════════

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.1 BLUESKY                                                             │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Parse Bluesky facets (links, mentions, hashtags) from text
 */
async function parseBlueskyFacets(
  text: string,
  _accessToken: string
): Promise<Array<{
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string; tag?: string }>;
}>> {
  const facets: Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<{ $type: string; uri?: string; did?: string; tag?: string }>;
  }> = [];
  const encoder = new TextEncoder();

  // Find URLs
  const urlRegex = /https?:\/\/[^\s\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const byteStart = encoder.encode(text.substring(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }],
    });
  }

  // Find hashtags
  const hashtagRegex = /#[a-zA-Z0-9_]+/g;
  while ((match = hashtagRegex.exec(text)) !== null) {
    const byteStart = encoder.encode(text.substring(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[0].substring(1) }],
    });
  }

  return facets;
}

/**
 * Post to Bluesky using AT Protocol
 * Supports both OAuth (with DPoP) and legacy app password authentication
 */
async function postToBluesky(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  supabase: SupabaseClient
): Promise<PlatformPostResult> {
  let accessToken = account.access_token;
  const refreshToken = account.refresh_token;
  const did = account.platform_user_id;
  const username = account.platform_username;
  const metadata = post.metadata;
  const accountMeta = account.account_metadata as Record<string, unknown> | null;

  console.log(`Bluesky: Starting post for user ${username}...`);

  // Determine if this is an OAuth account (has DPoP keys)
  const isOAuthAccount = accountMeta?.auth_method === "oauth" &&
    accountMeta?.dpop_private_key &&
    accountMeta?.dpop_public_key;

  // Resolve the PDS URL — OAuth tokens must be sent to the user's PDS, not bsky.social
  const pdsUrl = (isOAuthAccount && accountMeta?.pds_url)
    ? accountMeta.pds_url as string
    : "https://bsky.social";

  // Resolve the auth server token endpoint for OAuth token refresh
  const authServerUrl = (isOAuthAccount && accountMeta?.auth_server)
    ? accountMeta.auth_server as string
    : "https://bsky.social";

  console.log(`Bluesky: PDS URL: ${pdsUrl}, Auth Server: ${authServerUrl}`);

  // Variables to hold DPoP keys if OAuth account
  let dpopPrivateKey: CryptoKey | null = null;
  let dpopPublicKeyJWK: JsonWebKey | null = null;

  if (isOAuthAccount) {
    console.log("Bluesky: OAuth account detected, will use DPoP token binding");
    try {
      dpopPrivateKey = await importBlueskyPrivateKey(accountMeta!.dpop_private_key as JsonWebKey);
      dpopPublicKeyJWK = accountMeta!.dpop_public_key as JsonWebKey;
    } catch (e) {
      console.error("Bluesky: Failed to import DPoP keys:", e);
      // Fall back to treating as app password account
    }
  }

  // Bluesky tokens expire quickly, try to refresh if we have a refresh token
  if (refreshToken) {
    try {
      if (isOAuthAccount && dpopPrivateKey && dpopPublicKeyJWK) {
        // OAuth account: Use DPoP-bound token refresh
        console.log("Bluesky: Refreshing OAuth token with DPoP...");

        const tokenEndpoint = `${authServerUrl}/oauth/token`;

        // Generate DPoP proof for token refresh (no ath claim for token endpoint)
        let dpopProof = await generateBlueskyDPoPProof(
          dpopPrivateKey,
          dpopPublicKeyJWK,
          "POST",
          tokenEndpoint
        );

        let refreshResponse = await fetch(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "DPoP": dpopProof,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: "https://postora.cloud/client-metadata.json",
          }),
        });

        // DPoP Nonce Retry for token refresh
        if (refreshResponse.status === 400) {
          const refreshErrorData = await refreshResponse.json().catch(() => ({}));
          if (refreshErrorData.error === "use_dpop_nonce") {
            const serverNonce = refreshResponse.headers.get("DPoP-Nonce");
            if (serverNonce) {
              console.log("Bluesky: Token refresh requires DPoP nonce, retrying...");
              dpopProof = await generateBlueskyDPoPProof(
                dpopPrivateKey, dpopPublicKeyJWK, "POST", tokenEndpoint, undefined, serverNonce
              );
              refreshResponse = await fetch(tokenEndpoint, {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "DPoP": dpopProof,
                },
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  refresh_token: refreshToken,
                  client_id: "https://postora.cloud/client-metadata.json",
                }),
              });
            }
          }
        }

        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          accessToken = refreshData.access_token;

          // Update stored tokens
          await supabase.from("social_accounts").update({
            access_token: refreshData.access_token,
            refresh_token: refreshData.refresh_token,
            updated_at: new Date().toISOString(),
          }).eq("id", account.id);

          console.log("Bluesky: OAuth token refreshed successfully with DPoP");
        } else {
          const errorText = await refreshResponse.text();
          console.warn("Bluesky: OAuth token refresh failed:", refreshResponse.status, errorText);
        }
      } else {
        // Legacy app password: Use Bearer token refresh
        console.log("Bluesky: Refreshing app password token...");

        const refreshResponse = await fetch(
          `${pdsUrl}/xrpc/com.atproto.server.refreshSession`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${refreshToken}` },
          }
        );

        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          accessToken = refreshData.accessJwt;

          await supabase.from("social_accounts").update({
            access_token: refreshData.accessJwt,
            refresh_token: refreshData.refreshJwt,
            updated_at: new Date().toISOString(),
          }).eq("id", account.id);

          console.log("Bluesky: App password token refreshed successfully");
        }
      }
    } catch (e) {
      console.warn("Bluesky: Token refresh failed, using existing token:", e);
    }
  }

  // Helper to build authorization headers based on account type
  // Supports optional nonce for DPoP nonce binding (RFC 9449)
  async function getBlueskyAuthHeaders(method: string, url: string, dpopNonce?: string): Promise<Record<string, string>> {
    if (isOAuthAccount && dpopPrivateKey && dpopPublicKeyJWK) {
      // OAuth: Use DPoP authorization scheme with ath claim
      const dpopProof = await generateBlueskyDPoPProof(
        dpopPrivateKey,
        dpopPublicKeyJWK,
        method,
        url,
        accessToken, // Include ath claim for API calls
        dpopNonce
      );
      return {
        "Authorization": `DPoP ${accessToken}`,
        "DPoP": dpopProof,
      };
    } else {
      // App password: Use Bearer authorization
      return {
        "Authorization": `Bearer ${accessToken}`,
      };
    }
  }

  // Helper to make a DPoP-bound fetch with automatic nonce retry
  async function blueskyFetch(url: string, options: RequestInit): Promise<Response> {
    let response = await fetch(url, options);

    // DPoP Nonce Retry: if server requires nonce, retry with it
    if (isOAuthAccount && dpopPrivateKey && dpopPublicKeyJWK &&
        (response.status === 400 || response.status === 401)) {
      const body = await response.clone().json().catch(() => ({}));
      if (body.error === "use_dpop_nonce") {
        const serverNonce = response.headers.get("DPoP-Nonce");
        if (serverNonce) {
          console.log(`Bluesky: DPoP nonce required for ${url}, retrying...`);
          const method = (options.method || "GET").toUpperCase();
          const retryHeaders = await getBlueskyAuthHeaders(method, url, serverNonce);
          response = await fetch(url, {
            ...options,
            headers: {
              ...options.headers,
              ...retryHeaders,
            },
          });
        }
      }
    }

    return response;
  }

  // Build the post record
  const now = new Date().toISOString();
  const postRecord: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text: post.caption || "",
    createdAt: now,
  };

  // Add language if specified
  if (metadata?.bluesky_language) {
    postRecord.langs = [metadata.bluesky_language];
  }

  // Add reply control (threadgate) - stored in separate record after post creation
  const replyControl = metadata?.bluesky_reply_control;
  const replySettings = metadata?.bluesky_reply_settings;

  // Parse facets (links, mentions, hashtags) from text
  const facets = await parseBlueskyFacets(post.caption || "", accessToken);
  if (facets.length > 0) {
    postRecord.facets = facets;
  }

  // Add content warning labels if specified
  if (metadata?.bluesky_content_warning || metadata?.bluesky_adult_content) {
    const labels: Array<{ val: string }> = [];
    if (metadata.bluesky_content_warning) {
      labels.push({ val: metadata.bluesky_content_warning });
    }
    if (metadata.bluesky_adult_content) {
      labels.push({ val: "porn" });
    }
    if (labels.length > 0) {
      postRecord.labels = {
        $type: "com.atproto.label.defs#selfLabels",
        values: labels,
      };
    }
  }

  // Determine media types
  const imageUrls: string[] = [];
  let videoUrl: string | null = null;

  for (const url of mediaUrls) {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes(".mp4") || lowerUrl.includes(".mov") || lowerUrl.includes(".webm") ||
      lowerUrl.includes("video/") || lowerUrl.includes("/video")) {
      if (!videoUrl) {
        videoUrl = url;
      }
    } else {
      imageUrls.push(url);
    }
  }

  // Handle video upload (Bluesky supports single video)
  if (videoUrl) {
    try {
      console.log("Bluesky: Uploading video...");
      const { blob: videoBlob, mimeType: videoMimeType } = await downloadMediaAsBlob(videoUrl);
      const videoBuffer = new Uint8Array(await videoBlob.arrayBuffer());

      // Check video size (Bluesky limit is ~100MB)
      const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
      if (videoBuffer.length > MAX_VIDEO_SIZE) {
        throw new Error(`Video too large: ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB (max 100MB)`);
      }

      console.log(`Bluesky: Video size ${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB, type: ${videoMimeType}`);

      // Upload video blob
      const uploadUrl = `${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`;
      const authHeaders = await getBlueskyAuthHeaders("POST", uploadUrl);

      const uploadResponse = await blueskyFetch(uploadUrl, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": videoMimeType || "video/mp4",
        },
        body: videoBuffer,
      });

      const uploadData = await uploadResponse.json();

      if (uploadData.error) {
        console.error("Bluesky: Video upload failed:", uploadData);
        throw new Error(`Video upload failed: ${uploadData.message || uploadData.error}`);
      }

      console.log("Bluesky: Video uploaded successfully");

      // Create video embed
      postRecord.embed = {
        $type: "app.bsky.embed.video",
        video: uploadData.blob,
        alt: metadata?.bluesky_alt_text || "",
      };
    } catch (e) {
      console.error("Bluesky: Failed to process video:", e);
      throw e; // Re-throw video errors as they're critical
    }
  }
  // Handle images (max 4)
  else if (imageUrls.length > 0) {
    const images: Array<{
      alt: string;
      image: { $type: string; ref: { $link: string }; mimeType: string; size: number };
    }> = [];

    for (const imageUrl of imageUrls.slice(0, 4)) { // Max 4 images
      try {
        // Bluesky has a strict 1MB (1,000,000 bytes) limit per image blob
        const BLUESKY_MAX_IMAGE_SIZE = 1_000_000;
        let finalUrl = imageUrl;
        let blob: Blob;
        let mimeType: string;
        let imageBuffer: Uint8Array<ArrayBuffer>;

        // Try Cloudinary compression if the image is from Cloudinary
        const cloudinaryPattern = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)/;
        const cloudinaryMatch = imageUrl.match(cloudinaryPattern);
        const qualityLevels = cloudinaryMatch ? [80, 60, 40, 25] : [null];

        for (const quality of qualityLevels) {
          if (quality !== null && cloudinaryMatch) {
            const [, uploadBase, rest] = cloudinaryMatch;
            // Strip any existing transformations before the version/public_id
            const pathWithoutTransforms = rest.replace(/^([a-z_,0-9.]+\/)+(?=v\d)/, "");
            finalUrl = `${uploadBase}q_${quality},f_jpg,w_2000,c_limit/${pathWithoutTransforms}`;
            console.log(`[Bluesky] Cloudinary transform: q_${quality} → ${finalUrl}`);
          }

          const downloaded = await downloadMediaAsBlob(finalUrl);
          blob = downloaded.blob;
          mimeType = quality !== null ? "image/jpeg" : downloaded.mimeType;
          imageBuffer = new Uint8Array(await blob.arrayBuffer());

          const sizeMB = (imageBuffer.length / 1_000_000).toFixed(2);
          if (imageBuffer.length <= BLUESKY_MAX_IMAGE_SIZE) {
            console.log(`[Bluesky] Image size OK: ${sizeMB}MB (${imageBuffer.length} bytes)`);
            break;
          }
          console.log(`[Bluesky] Image too large: ${sizeMB}MB (limit 1.00MB) — trying next quality level`);
        }

        // Final size check
        if (imageBuffer!.length > BLUESKY_MAX_IMAGE_SIZE) {
          console.error(`[Bluesky] SKIPPING image — still ${(imageBuffer!.length / 1_000_000).toFixed(2)}MB after max compression (limit 1.00MB). URL: ${imageUrl}`);
          continue;
        }

        // Get auth headers for blob upload
        const uploadUrl = `${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`;
        const authHeaders = await getBlueskyAuthHeaders("POST", uploadUrl);

        // Upload to Bluesky
        const uploadResponse = await blueskyFetch(uploadUrl, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": mimeType!,
          },
          body: imageBuffer!,
        });

        const uploadData = await uploadResponse.json();

        if (uploadData.error) {
          console.error("Bluesky: Image upload failed:", uploadData);
          continue;
        }

        images.push({
          alt: metadata?.bluesky_alt_text || "",
          image: uploadData.blob,
        });
      } catch (e) {
        console.error("Bluesky: Failed to process image:", e);
      }
    }

    if (images.length > 0) {
      postRecord.embed = {
        $type: "app.bsky.embed.images",
        images,
      };
    }
  }

  // Add external embed if specified (and no media)
  if (metadata?.bluesky_embed_link && !postRecord.embed) {
    postRecord.embed = {
      $type: "app.bsky.embed.external",
      external: {
        uri: metadata.bluesky_embed_link,
        title: "Shared link",
        description: "",
      },
    };
  }

  console.log("Bluesky: Creating post record...");

  // Get auth headers for post creation
  const createUrl = `${pdsUrl}/xrpc/com.atproto.repo.createRecord`;
  const createAuthHeaders = await getBlueskyAuthHeaders("POST", createUrl);

  // Create the post
  const createResponse = await blueskyFetch(createUrl, {
    method: "POST",
    headers: {
      ...createAuthHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record: postRecord,
    }),
  });

  const createData = await createResponse.json();

  console.log("Bluesky: Create response:", JSON.stringify(createData).slice(0, 200));

  if (createData.error) {
    throw new Error(`Bluesky API error: ${createData.message || createData.error}`);
  }

  // Extract post ID from URI (at://did:plc:xxx/app.bsky.feed.post/xxx)
  const uri = createData.uri;
  const postId = uri?.split("/").pop();

  // Create threadgate for reply control if specified
  // Use new single-select replySettings if available, otherwise fall back to legacy replyControl
  const shouldCreateThreadgate = replySettings
    ? (replySettings.selectedOption !== "anyone")
    : (replyControl && replyControl !== "everyone");

  if (shouldCreateThreadgate && uri) {
    try {
      console.log(`Bluesky: Creating threadgate for reply control (option: ${replySettings?.selectedOption || replyControl})`);

      const threadgateRecord: Record<string, unknown> = {
        $type: "app.bsky.feed.threadgate",
        post: uri,
        createdAt: now,
        allow: [],
      };

      // Set allowed reply rules based on selected option
      const allowRules: Array<{ $type: string; list?: string }> = [];

      if (replySettings) {
        // Use new single-select reply settings
        switch (replySettings.selectedOption) {
          case "nobody":
            // Nobody can reply - empty allow array
            console.log("Bluesky: Setting threadgate to block all replies");
            break;
          case "following":
            allowRules.push({ $type: "app.bsky.feed.threadgate#followingRule" });
            break;
          case "mentioned":
            allowRules.push({ $type: "app.bsky.feed.threadgate#mentionRule" });
            break;
          case "list":
            if (replySettings.selectedListUri) {
              allowRules.push({
                $type: "app.bsky.feed.threadgate#listRule",
                list: replySettings.selectedListUri
              });
            }
            break;
        }
        console.log(`Bluesky: Threadgate rules: ${JSON.stringify(allowRules)}`);
      } else if (replyControl) {
        // Legacy fallback
        if (replyControl === "following") {
          allowRules.push({ $type: "app.bsky.feed.threadgate#followingRule" });
        } else if (replyControl === "mentioned") {
          allowRules.push({ $type: "app.bsky.feed.threadgate#mentionRule" });
        }
      }

      threadgateRecord.allow = allowRules;

      const threadgateUrl = `${pdsUrl}/xrpc/com.atproto.repo.createRecord`;
      const threadgateAuthHeaders = await getBlueskyAuthHeaders("POST", threadgateUrl);

      await blueskyFetch(threadgateUrl, {
        method: "POST",
        headers: {
          ...threadgateAuthHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: did,
          collection: "app.bsky.feed.threadgate",
          rkey: postId, // Same rkey as the post
          record: threadgateRecord,
        }),
      });

      console.log("Bluesky: Threadgate created for reply control");
    } catch (e) {
      console.warn("Bluesky: Failed to create threadgate (non-fatal):", e);
    }
  }

  // Build profile URL
  const handle = username?.replace(/^@/, "");
  const postUrl = handle && postId ? `https://bsky.app/profile/${handle}/post/${postId}` : undefined;

  console.log(`Bluesky: Post created successfully! URL: ${postUrl}`);

  return {
    id: postId,
    url: postUrl,
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.2 FACEBOOK                                                            │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Extract the actual post ID from Facebook's compound ID (pageId_postId)
 */
function extractFacebookPostId(compoundId: string): string {
  // Facebook returns IDs like "123456789_987654321" where first part is page ID
  const parts = compoundId.split("_");
  return parts.length > 1 ? parts[1] : compoundId;
}

/**
 * Post a Facebook Reel (video)
 */
async function postFacebookReel(
  pageId: string,
  accessToken: string,
  username: string,
  caption: string,
  videoUrl: string,
  reelDescription?: string | null,
  post?: PostData | null
): Promise<PlatformPostResult> {
  console.log("Posting Facebook Reel...");

  // Step 1: Initialize the Reel upload
  const initResponse = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "start",
        access_token: accessToken,
      }),
    }
  );

  const initData = await initResponse.json();
  console.log("Facebook Reel init response:", JSON.stringify(initData).slice(0, 200));

  if (initData.error) {
    throw new Error(`Facebook Reel init error: ${initData.error.message}`);
  }

  const videoId = initData.video_id;
  const uploadUrl = initData.upload_url;

  if (!videoId || !uploadUrl) {
    throw new Error("Facebook Reel init failed: missing video_id or upload_url");
  }

  // Step 2: Download and upload the video
  console.log("Downloading video for Facebook Reel...");
  const { buffer, size } = await downloadMediaAsArrayBuffer(videoUrl);

  console.log(`Uploading Reel video (${size} bytes)...`);

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": `OAuth ${accessToken}`,
      "offset": "0",
      "file_size": String(size),
    },
    body: buffer,
  });

  const uploadData = await uploadResponse.json();
  console.log("Facebook Reel upload response:", JSON.stringify(uploadData).slice(0, 200));

  if (uploadData.error) {
    throw new Error(`Facebook Reel upload error: ${uploadData.error.message}`);
  }

  // Step 3: Finish the Reel upload and publish
  console.log("Finalizing Facebook Reel...");
  const finishResponse = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        description: reelDescription || caption,
        access_token: accessToken,
      }),
    }
  );

  const finishData = await finishResponse.json();
  console.log("Facebook Reel finish response:", JSON.stringify(finishData).slice(0, 200));

  if (finishData.error) {
    throw new Error(`Facebook Reel publish error: ${finishData.error.message}`);
  }

  // Construct Reel URL
  const reelId = finishData.video_id || videoId;
  const reelUrl = `https://www.facebook.com/reel/${reelId}`;

  console.log(`Facebook Reel published successfully! URL: ${reelUrl}`);

  // Reel collaborator invitation (page-to-page)
  const reelWarnings: string[] = [];
  const collaboratorPageId = post?.metadata?.facebook_reel_collaborator;
  if (collaboratorPageId && reelId) {
    try {
      console.log(`Facebook Reel: Inviting collaborator page ${collaboratorPageId}...`);
      const collabRes = await fetch(
        `https://graph.facebook.com/v18.0/${reelId}/collaborators`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collaborator_page_id: collaboratorPageId,
            access_token: accessToken,
          }),
        }
      );
      const collabData = await collabRes.json();
      if (collabData.error) {
        console.error("Facebook Reel collaborator error:", collabData.error.message);
        reelWarnings.push(`Reel collaborator invite failed: ${collabData.error.message}`);
      } else {
        console.log("Facebook Reel collaborator invited:", JSON.stringify(collabData).slice(0, 200));
      }
    } catch (e) {
      console.error("Facebook Reel collaborator failed:", e);
      reelWarnings.push(`Reel collaborator invite failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  return {
    id: reelId,
    url: reelUrl,
    warnings: reelWarnings,
  };
}

/**
 * Post to Facebook (feed posts, photos, multi-photo albums, Reels)
 */
async function postToFacebook(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  mediaFiles: MediaFile[] = []
): Promise<PlatformPostResult> {
  const pageId = account.platform_user_id;
  const accessToken = account.access_token;
  const username = account.platform_username || pageId;

  // Check if this is a Page token (required for posting)
  const accountType = (account.account_metadata as Record<string, unknown>)?.type;
  if (accountType === "user") {
    throw new Error("Cannot post with a user account. Please connect a Facebook Page instead.");
  }

  // Get Facebook settings from metadata
  const metadata = post.metadata;
  const rawPostType = metadata?.facebook_post_type || "feed";
  // Normalize to array for multi-select support (backward compatible with string)
  const postTypes: string[] = Array.isArray(rawPostType) ? rawPostType : [rawPostType];

  console.log(`Posting to Facebook Page: ${pageId}, types: ${JSON.stringify(postTypes)}`);

  // If multiple post types selected, iterate and collect results
  const allResults: PlatformPostResult[] = [];

  for (const postType of postTypes) {
    // Handle Facebook Reels
    if (postType === "reel" && mediaUrls.length > 0) {
      const reelResult = await postFacebookReel(
        pageId,
        accessToken,
        username,
        post.caption || "",
        mediaUrls[0],
        metadata?.facebook_reel_description,
        post
      );
      allResults.push(reelResult);
      continue;
    }

    // Handle Facebook Stories (primary story posting path) — Two-step upload
    if (postType === "story" && mediaUrls.length > 0) {
    let isVideo = false;
    if (mediaFiles.length > 0) {
      const ft = mediaFiles[0].file_type || (mediaFiles[0].mime_type?.startsWith("video/") ? "video" : "image");
      isVideo = ft === "video";
    } else {
      isVideo = isVideoUrl(mediaUrls[0]);
    }

    const mediaUrl = mediaUrls[0];
    console.log(`Facebook Story posting: isVideo=${isVideo}, mediaUrl=${mediaUrl.slice(0, 80)}`);

    if (isVideo) {
      // Video Story: 3-step process
      // Step 1: Initialize upload
      const initRes = await fetch(`https://graph.facebook.com/v18.0/${pageId}/video_stories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_phase: "start", access_token: accessToken }),
      });
      const initData = await initRes.json();
      console.log("FB Story video init:", JSON.stringify(initData).slice(0, 300));
      if (initData.error) {
        throw new Error(`Facebook Story video init failed: ${initData.error.message}`);
      }
      const videoId = initData.video_id;
      const uploadUrl = initData.upload_url;

      // Step 2: Upload the video binary to Meta's resumable upload URL
      console.log("FB Story: Downloading video binary for upload...");
      const { buffer, mimeType, size } = await downloadMediaAsArrayBuffer(mediaUrl);
      console.log(`FB Story: Video downloaded, size=${size} bytes, mimeType=${mimeType}`);

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Authorization": `OAuth ${accessToken}`,
          "offset": "0",
          "file_size": String(size),
        },
        body: buffer,
      });
      const uploadData = await uploadRes.json();
      console.log("FB Story video upload:", JSON.stringify(uploadData).slice(0, 300));
      if (uploadData.error) {
        throw new Error(`Facebook Story video upload failed: ${uploadData.error.message}`);
      }
      if (!uploadRes.ok || uploadData.success !== true) {
        throw new Error(`Facebook Story video upload failed: ${JSON.stringify(uploadData).slice(0, 200)}`);
      }

      // Step 3: Finish / publish
      const finishRes = await fetch(`https://graph.facebook.com/v18.0/${pageId}/video_stories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_phase: "finish", video_id: videoId, access_token: accessToken }),
      });
      const finishData = await finishRes.json();
      console.log("FB Story video finish:", JSON.stringify(finishData).slice(0, 300));
      if (finishData.error) {
        throw new Error(`Facebook Story video publish failed: ${finishData.error.message}`);
      }

      const storyId = finishData.post_id || finishData.id || videoId;
      allResults.push({ id: storyId, url: `https://www.facebook.com/stories/${pageId}/${storyId}`, warnings: [] });
      continue;
    } else {
      // Photo Story: 2-step process
      // Step 1: Upload photo as unpublished to get photo_id
      const photoUploadRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: mediaUrl, published: false, access_token: accessToken }),
      });
      const photoUploadData = await photoUploadRes.json();
      console.log("FB Story photo upload:", JSON.stringify(photoUploadData).slice(0, 300));
      if (photoUploadData.error) {
        throw new Error(`Facebook Story photo upload failed: ${photoUploadData.error.message}`);
      }
      const photoId = photoUploadData.id;

      // Step 2: Publish as photo story
      const storyRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photo_stories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, access_token: accessToken }),
      });
      const storyData = await storyRes.json();
      console.log("FB Story photo publish:", JSON.stringify(storyData).slice(0, 300));
      if (storyData.error) {
        throw new Error(`Facebook Story failed: ${storyData.error.message}`);
      }

      const storyId = storyData.post_id || storyData.id;
      allResults.push({ id: storyId, url: `https://www.facebook.com/stories/${pageId}/${storyId}`, warnings: [] });
      continue;
    }
  }
  }

  // If we only had non-feed types (story/reel) and all were handled, return combined result
  if (allResults.length > 0 && !postTypes.includes("feed")) {
    const combined = allResults[allResults.length - 1];
    return combined;
  }


  // Facebook warnings array for first comment / story failures
  const fbWarnings: string[] = [];

  // Helper: post first comment after successful post
  const postFirstComment = async (postId: string) => {
    const firstComment = metadata?.facebook_first_comment;
    if (!firstComment) return;
    try {
      const commentRes = await fetch(
        `https://graph.facebook.com/v18.0/${postId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: firstComment, access_token: accessToken }),
        }
      );
      const commentData = await commentRes.json();
      if (commentData.error) {
        console.error("Facebook first comment error:", commentData.error.message);
        fbWarnings.push(`First comment failed: ${commentData.error.message}`);
      } else {
        console.log("Facebook first comment posted:", commentData.id);
      }
    } catch (e) {
      console.error("Facebook first comment failed:", e);
      fbWarnings.push(`First comment failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  };

  // Helper: share to story after feed post
  // Photo: 2-step flow (POST /photos published=false → photo_id, then POST /photo_stories with photo_id)
  // Video: requires resumable rupload binary upload — not supported here. We push a warning
  //        and recommend using the dedicated "Story" post-type for videos (handled above).
  const shareToStory = async () => {
    if (!metadata?.facebook_share_to_story || mediaUrls.length === 0) return;
    try {
      let isVideo = false;
      if (mediaFiles.length > 0) {
        const ft = mediaFiles[0].file_type || (mediaFiles[0].mime_type?.startsWith("video/") ? "video" : "image");
        isVideo = ft === "video";
      } else {
        isVideo = isVideoUrl(mediaUrls[0]);
      }

      if (isVideo) {
        // TODO: implement video story via 3-step rupload.facebook.com flow.
        // For now, surface a clear warning so user knows it didn't post.
        const msg = "Also share to Story: video stories require resumable upload — please use the 'Story' post-type instead of the toggle for videos.";
        console.warn(`FB ${msg}`);
        fbWarnings.push(msg);
        return;
      }

      // PHOTO: Step 1 — upload as unpublished to get photo_id
      const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: mediaUrls[0], published: false, access_token: accessToken }),
      });
      const uploadData = await uploadRes.json();
      if (uploadData.error) {
        const msg = `Also share to Story failed (upload): ${uploadData.error.message}`;
        console.error(`FB ${msg}`);
        fbWarnings.push(msg);
        return;
      }
      const photoId = uploadData.id;
      console.log("Facebook story photo uploaded:", photoId);

      // PHOTO: Step 2 — publish as photo_story using the photo_id
      const storyRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photo_stories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, access_token: accessToken }),
      });
      const storyData = await storyRes.json();
      if (storyData.error) {
        const msg = `Also share to Story failed (publish): ${storyData.error.message}`;
        console.error(`FB ${msg}`);
        fbWarnings.push(msg);
        return;
      }
      console.log("Facebook story published:", storyData.post_id || storyData.id);
    } catch (e) {
      const msg = `Also share to Story failed: ${e instanceof Error ? e.message : "Unknown error"}`;
      console.error(`FB ${msg}`);
      fbWarnings.push(msg);
    }
  };

  // Photo tags feature removed — /{photo-id}/tags endpoint was deprecated after Graph API v3.2

  // ── Facebook Location: pre-publish eligibility check ────────────────────
  // Validate the selected place ID before sending it to Meta. Invalid /
  // non-place Pages cause Meta to silently drop `place` on success — we want
  // to either skip with a clear warning or surface the silent drop later.
  const fbLocationId = metadata?.facebook_location_id;
  const fbLocationObj = (metadata as Record<string, unknown> | undefined)?.facebook_location_object as
    | { id?: string; name?: string; source?: string } | undefined;
  let effectiveFbPlaceId: string | null = null;
  if (fbLocationId && !fbLocationId.startsWith("osm_")) {
    const check = await checkFacebookPlaceEligibility(fbLocationId, accessToken);
    if (check.eligible) {
      effectiveFbPlaceId = fbLocationId;
    } else {
      const placeName = check.name || fbLocationObj?.name || "this place";
      fbWarnings.push(
        `Facebook location skipped — '${placeName}' is not a taggable place. Pick a more specific location with city/coordinates.`
      );
      // Fire-and-forget structured log
      logLocationEvent({
        userId: post.user_id,
        errorCode: "fb_location_skipped_pre_publish",
        level: "warn",
        message: `Facebook location skipped pre-publish (${check.reason || "ineligible"})`,
        details: {
          platform: "facebook",
          social_account_id: account.id,
          post_id: post.id,
          location_id: fbLocationId,
          location_name: placeName,
          location_source: fbLocationObj?.source || null,
          meta_endpoint: "/v18.0/{place_id}",
          reason: check.reason || "ineligible",
        },
      });
    }
  } else if (fbLocationId && fbLocationId.startsWith("osm_")) {
    logLocationEvent({
      userId: post.user_id,
      errorCode: "fb_location_skipped_pre_publish",
      level: "info",
      message: "Facebook location skipped — OSM reference",
      details: {
        platform: "facebook",
        social_account_id: account.id,
        post_id: post.id,
        location_id: fbLocationId,
        reason: "osm_reference",
      },
    });
  }
  const hasFbLocation = !!effectiveFbPlaceId;

  // Helper: POST to FB endpoint with retry-without-location safety net.
  // Returns the parsed JSON response (after at most one retry).
  const fbPostWithLocationRetry = async (
    endpoint: string,
    body: Record<string, unknown>,
    placeKey: "place" = "place",
  ): Promise<{ data: GraphResponse; status: number; placeAttempted: boolean }> => {
    const placeAttempted = body[placeKey] != null;
    const doFetch = async (b: Record<string, unknown>) => {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      const d = await r.json();
      return { d, s: r.status };
    };
    let { d, s } = await doFetch(body);
    if (placeAttempted && d?.error && isFbLocationError(d.error as { message?: string; code?: number; error_subcode?: number })) {
      console.warn(
        `Facebook: location-related error (code=${(d.error as { code?: number }).code}, subcode=${(d.error as { error_subcode?: number }).error_subcode}) — retrying without place`
      );
      const retryBody = { ...body };
      delete retryBody[placeKey];
      const retry = await doFetch(retryBody);
      if (!retry.d?.error) {
        fbWarnings.push("Facebook retried without location after Meta rejected the place tag.");
        logLocationEvent({
          userId: post.user_id,
          errorCode: "fb_location_retry_without",
          level: "warn",
          message: "Facebook publish retried without location",
          details: {
            platform: "facebook",
            social_account_id: account.id,
            post_id: post.id,
            location_id: effectiveFbPlaceId,
            meta_endpoint: endpoint.replace(/access_token=[^&]+/g, "").replace(/^https:\/\/graph\.facebook\.com/, ""),
            meta_error_code: (d.error as { code?: number }).code ?? null,
            meta_error_message: safeMetaErrorMessage((d.error as { message?: string }).message),
          },
        });
      }
      d = retry.d;
      s = retry.s;
    }
    return { data: d, status: s, placeAttempted };
  };

  // Helper: post-publish silent-drop verification.
  // Awaited so the warning lands in `fbWarnings` BEFORE the surrounding
  // function returns it for persistence into platform_posts.response_data.warnings[].
  // Logging stays fire-and-forget; verify request itself has a short timeout (2.5s)
  // inside `verifyFacebookPlaceAttached` so publishing is not delayed.
  const verifyAndWarnSilentDrop = async (postId: string): Promise<void> => {
    // No place was attempted → nothing to verify, no warning.
    if (!effectiveFbPlaceId || !postId) return;
    const attached = await verifyFacebookPlaceAttached(postId, accessToken);
    console.log(`Facebook place verification for post ${postId}: attached=${attached}`);
    if (attached === false) {
      fbWarnings.push("Facebook published successfully, but Meta did not attach the selected place.");
      logLocationEvent({
        userId: post.user_id,
        errorCode: "fb_location_silently_dropped",
        level: "warn",
        message: "Facebook published but place was silently dropped by Meta",
        details: {
          platform: "facebook",
          social_account_id: account.id,
          post_id: post.id,
          platform_post_id: postId,
          location_id: effectiveFbPlaceId,
          location_name: fbLocationObj?.name || null,
          page_id: pageId,
          meta_endpoint: "/v18.0/{post_id}",
        },
      });
    } else if (attached === null) {
      // Verification could not be completed (timeout / network / Meta lookup error).
      // Do NOT fail the post — surface a softer warning so the user knows.
      fbWarnings.push("Facebook published successfully, but location verification could not be completed.");
      logLocationEvent({
        userId: post.user_id,
        errorCode: "fb_location_verify_failed",
        level: "info",
        message: "Facebook publish succeeded but place verification lookup failed",
        details: {
          platform: "facebook",
          social_account_id: account.id,
          post_id: post.id,
          platform_post_id: postId,
          location_id: effectiveFbPlaceId,
          page_id: pageId,
          meta_endpoint: "/v18.0/{post_id}",
        },
      });
    }
  };

  if (mediaUrls.length === 0) {
    // Text-only post to Page feed
    const feedBody: Record<string, unknown> = {
      message: post.caption,
      access_token: accessToken,
    };
    if (metadata?.facebook_link) {
      feedBody.link = metadata.facebook_link;
    }
    if (hasFbLocation) {
      feedBody.place = effectiveFbPlaceId;
    }

    const { data } = await fbPostWithLocationRetry(
      `https://graph.facebook.com/v18.0/${pageId}/feed`,
      feedBody,
    );
    console.log("Facebook text post response:", JSON.stringify(data).slice(0, 200));

    if (data.error) {
      throw new Error(`Facebook API error: ${data.error.message} (code: ${data.error.code})`);
    }

    const postId = extractFacebookPostId(data.id as string);
    await postFirstComment(data.id as string);
    await verifyAndWarnSilentDrop(data.id as string);
    return {
      id: postId,
      url: `https://www.facebook.com/${pageId}/posts/${postId}`,
      warnings: fbWarnings,
    };

  } else if (mediaUrls.length === 1) {
    const mediaUrl = mediaUrls[0];
    // Detect video: prefer file_type from DB, fallback to URL check
    let mediaIsVideo = false;
    if (mediaFiles.length > 0) {
      const ft = mediaFiles[0].file_type || (mediaFiles[0].mime_type?.startsWith("video/") ? "video" : "image");
      mediaIsVideo = ft === "video";
    } else {
      mediaIsVideo = isVideoUrl(mediaUrl);
    }

    if (mediaIsVideo) {
      // Single video post — use /videos endpoint (not /photos)
      const videoBody: Record<string, unknown> = {
        file_url: mediaUrl,
        description: post.caption,
        access_token: accessToken,
      };
      if (hasFbLocation) {
        videoBody.place = effectiveFbPlaceId;
      }
      if (metadata?.facebook_link) {
        fbWarnings.push("Link preview was ignored: Facebook video posts do not support clickable link previews.");
      }

      const { data } = await fbPostWithLocationRetry(
        `https://graph.facebook.com/v18.0/${pageId}/videos`,
        videoBody,
      );
      console.log("Facebook video post response:", JSON.stringify(data).slice(0, 200));

      if (data.error) {
        throw new Error(`Facebook API error: ${data.error.message} (code: ${data.error.code})`);
      }

      const videoId = data.id as string;
      await postFirstComment(videoId);
      await shareToStory();
      await verifyAndWarnSilentDrop(videoId);
      return {
        id: videoId,
        url: `https://www.facebook.com/${username}/videos/${videoId}`,
        warnings: fbWarnings,
      };
    } else {
      // Single photo post to Page
      const photoBody: Record<string, unknown> = {
        url: mediaUrl,
        caption: post.caption,
        access_token: accessToken,
      };
      if (hasFbLocation) {
        photoBody.place = effectiveFbPlaceId;
      }
      if (metadata?.facebook_link) {
        fbWarnings.push("Link preview was ignored: Facebook photo posts do not support clickable link previews. Use a text-only post or multi-photo album to attach a link.");
      }

      const { data } = await fbPostWithLocationRetry(
        `https://graph.facebook.com/v18.0/${pageId}/photos`,
        photoBody,
      );
      console.log("Facebook photo post response:", JSON.stringify(data).slice(0, 200));

      if (data.error) {
        throw new Error(`Facebook API error: ${data.error.message} (code: ${data.error.code})`);
      }

      const photoId = data.id as string; // The photo object ID
      const fullPostId = (data.post_id as string) || (data.id as string);
      await postFirstComment(fullPostId);
      await shareToStory();
      await verifyAndWarnSilentDrop(fullPostId);

      // Fetch canonical photo link from Graph API
      let photoUrl = `https://www.facebook.com/${pageId}/posts/${extractFacebookPostId(fullPostId)}`;
      try {
        const linkRes = await fetch(
          `https://graph.facebook.com/v18.0/${photoId}?fields=link&access_token=${accessToken}`
        );
        const linkData = await linkRes.json();
        if (linkData.link) {
          photoUrl = linkData.link;
          console.log("Facebook: Got canonical photo link:", photoUrl);
        }
      } catch (e) {
        console.warn("Facebook: Failed to fetch photo link:", e);
      }

      return {
        id: extractFacebookPostId(fullPostId),
        url: photoUrl,
        warnings: fbWarnings,
      };
    }

  } else {
    // Multi-photo album post to Page
    const photoIds: string[] = [];

    for (const url of mediaUrls) {
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${pageId}/photos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            published: false,
            access_token: accessToken,
          }),
        }
      );

      const data = await response.json();
      if (data.error) {
        throw new Error(`Facebook API error uploading photo: ${data.error.message}`);
      }
      photoIds.push(data.id);
    }


    // Publish all photos together as a post
    const attachedMedia = photoIds.map(id => ({ media_fbid: id }));
    const feedBody: Record<string, unknown> = {
      message: post.caption,
      attached_media: attachedMedia,
      access_token: accessToken,
    };
    if (metadata?.facebook_link) {
      feedBody.link = metadata.facebook_link;
    }
    if (hasFbLocation) {
      feedBody.place = effectiveFbPlaceId;
    }

    let { data } = await fbPostWithLocationRetry(
      `https://graph.facebook.com/v18.0/${pageId}/feed`,
      feedBody,
    );
    console.log("Facebook multi-photo post response:", JSON.stringify(data).slice(0, 200));

    // Retry once for transient error code 1 (rate limit / data throttle)
    if (data.error && data.error.code === 1) {
      console.warn("Facebook: Transient error code 1, retrying after 3s...");
      await new Promise(resolve => setTimeout(resolve, 3000));
      const retryResponse = await fetch(
        `https://graph.facebook.com/v18.0/${pageId}/feed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(feedBody),
        }
      );
      data = await retryResponse.json();
      console.log("Facebook multi-photo retry response:", JSON.stringify(data).slice(0, 200));
    }

    if (data.error) {
      if (data.error.code === 1) {
        throw new Error(`Facebook is temporarily throttling requests. Please reduce the number of images or wait a few minutes and try again. (code: ${data.error.code})`);
      }
      throw new Error(`Facebook API error: ${data.error.message} (code: ${data.error.code})`);
    }

    const postId = extractFacebookPostId(data.id as string);
    await postFirstComment(data.id as string);
    await shareToStory();
    await verifyAndWarnSilentDrop(data.id as string);
    return {
      id: postId,
      url: `https://www.facebook.com/${pageId}/posts/${postId}`,
      warnings: fbWarnings,
    };
  }
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.3 INSTAGRAM                                                           │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Optimize a Cloudinary image URL for Instagram's media crawler.
 * Instagram's servers are stricter than Facebook's when fetching image_url.
 * This injects f_jpg,q_auto transformations to force JPEG output with proper
 * Content-Type headers, which Instagram handles reliably.
 * Videos are left untouched (they use video_url, not image_url).
 */
async function optimizeUrlForInstagram(url: string): Promise<string> {
  // Only optimize Cloudinary image URLs (not videos)
  if (url.includes("cloudinary.com") && url.includes("/image/upload/") && !isVideoUrl(url)) {
    // Inject f_jpg,q_auto after /upload/ to force JPEG delivery
    const optimized = url.replace("/image/upload/", "/image/upload/f_jpg,q_auto/");
    console.log(`Instagram URL optimized: ${url.slice(-80)} → ${optimized.slice(-80)}`);

    // Pre-flight HEAD check to verify URL is accessible
    try {
      const headRes = await fetchWithTimeout(optimized, { method: "HEAD" }, 8000);
      if (!headRes.ok) {
        console.warn(`Instagram pre-flight HEAD check failed (${headRes.status}), using original URL`);
        return url;
      }
      const contentType = headRes.headers.get("content-type") || "";
      console.log(`Instagram pre-flight OK: status=${headRes.status}, content-type=${contentType}`);
    } catch (e) {
      console.warn(`Instagram pre-flight HEAD check error, using original URL:`, e);
      return url;
    }

    return optimized;
  }
  return url;
}

/**
 * Optimize an array of URLs for Instagram
 */
async function optimizeUrlsForInstagram(urls: string[]): Promise<string[]> {
  return Promise.all(urls.map(url => optimizeUrlForInstagram(url)));
}

/**
 * Waits for an Instagram container (either login) until it can be published. The wait is
 * `pollContainer`'s, so the deadline bounds the requests as well as the sleeps, for every
 * container, deferrable or not; a Meta API error fails with Meta's reason and a server error
 * is retried. When time runs out `unfinishedError` decides: a deferrable container
 * (`wait.deferKind`) is left for the reconciler, any other fails with "Safe to retry".
 */
async function waitForInstagramContainer(
  statusUrl: string,
  containerId: string,
  maxAttempts: number,
  delayMs: number,
  wait: ContainerWait,
): Promise<string> {
  const container = await pollContainer("instagram", statusUrl, {
    maxAttempts,
    intervalMs: delayMs,
    checkFirst: true,
    deadlineMs: wait.deadlineMs,
  });
  switch (container.state) {
    case "published":
      return "PUBLISHED";
    case "finished": {
      // A buffer after FINISHED lets Instagram's backend settle; it counts against the deadline.
      const bufferMs = bufferAfterFinishedMs(wait.deadlineMs, Date.now());
      if (bufferMs > 0) {
        console.log(`Container ${containerId} finished, waiting ${bufferMs}ms before publish...`);
        await new Promise((resolve) => setTimeout(resolve, bufferMs));
      }
      return "FINISHED";
    }
    case "failed":
      throw new Error(containerFailureMessage("instagram", container.reason));
    default:
      throw unfinishedError(wait, containerId, "Instagram");
  }
}

/**
 * Poll Instagram container status until ready
 */
function pollContainerStatus(
  containerId: string,
  accessToken: string,
  wait: ContainerWait,
  maxAttempts = 60, // Increased from 30 to 60 (2 min total for large video reels)
  delayMs = 2000,
): Promise<string> {
  return waitForInstagramContainer(
    `https://graph.facebook.com/v18.0/${containerId}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
    containerId,
    maxAttempts,
    delayMs,
    wait,
  );
}

/**
 * An Instagram container's state, asked once. Only the container's own ERROR or EXPIRED is a
 * failure: a status request that fails (an expired token, a 5xx, a timeout) says nothing about
 * the publish, so it comes back as `waiting`, i.e. unknown.
 */
async function checkContainerOnce(statusUrl: string, timeoutMs: number): Promise<ContainerState> {
  try {
    const response = await fetchWithTimeout(statusUrl, {}, timeoutMs);
    if (!response.ok) return { state: "waiting" };
    return classifyContainerStatus("instagram", await response.json());
  } catch {
    return { state: "waiting" };
  }
}

/**
 * The media a published container became, looked up in the account's latest media (see
 * matchPublishedMedia), or null when it cannot be told for sure.
 */
async function findPublishedMedia(
  mediaListUrl: string,
  accessToken: string,
  caption: string | null | undefined,
  notBeforeMs: number,
): Promise<MediaSummary | null> {
  const media = await listRecentMedia(mediaListUrl, accessToken);
  return media ? matchPublishedMedia(media, caption, notBeforeMs) : null;
}

/**
 * What earlier runs recorded for this account on the post: its story (a story is not in `/media`,
 * so its own row is the only record) and its feed post or reel. A failed read counts as nothing
 * recorded, like the media list: the retry behaves as it always did.
 */
async function recordedOnRetry(supabase: SupabaseClient, postId: string, socialAccountId: string): Promise<{ story: boolean; feed: boolean }> {
  const { data, error } = await supabase
    .from("platform_posts")
    .select("status, story_subtype:response_data->>ig_post_subtype, story_on_reel:response_data->>story_recorded_on_reel_row, carried_story:response_data->unrecorded_story")
    .eq("post_id", postId)
    .eq("social_account_id", socialAccountId)
    .in("status", ["success", "failed"]);
  if (error) {
    console.warn(`[instagram] retry guard could not read the recorded rows for post ${postId}: ${error.message}`);
    return { story: false, feed: false };
  }
  return recordedOnRetryRows((data ?? []) as RecordedRow[]);
}

/**
 * Which of these media ids another post's row records for the account, or null when unreadable.
 * This post's own rows are not counted: its recorded media is handled as `feedRecorded`.
 */
async function recordedMediaIdsFor(supabase: SupabaseClient, postId: string, socialAccountId: string, ids: string[]): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from("platform_posts")
    .select("platform_post_id")
    .eq("social_account_id", socialAccountId)
    .neq("post_id", postId)
    .in("platform_post_id", ids);
  if (error) return null;
  return new Set((data ?? []).map((row: { platform_post_id: string | null }) => row.platform_post_id ?? ""));
}

/** The account's latest media, or null when they could not be read (non-200, timeout, error). */
async function listRecentMedia(mediaListUrl: string, accessToken: string): Promise<MediaSummary[] | null> {
  try {
    const response = await fetchWithTimeout(
      `${mediaListUrl}?fields=id,caption,timestamp,permalink,media_type&limit=${PUBLISHED_SEARCH_LIMIT}&access_token=${accessToken}`,
      {},
      8000,
    );
    if (!response.ok) return null;
    const body = await response.json() as { data?: unknown };
    // A list Graph answered but malformed counts as unreadable, so the retry publishes as before.
    return parseMediaList(body.data);
  } catch {
    return null;
  }
}

/**
 * Step 4's retry guard: on a retry, the post as it already is on the account, or null to publish
 * as usual (not a retry, no caption, a story-only post, nothing live, or the media unreadable).
 */
async function liveOnRetry(
  post: PostData,
  retry: RetryState,
  mediaListUrl: string,
  accessToken: string,
  publish: { storyOnly: boolean; mediaType: string },
): Promise<Exclude<RetryGuardDecision, { kind: "publish" }> | null> {
  if (publish.storyOnly || !post.caption?.trim() || !retry.recordedMediaIds) return null;
  const media = await listRecentMedia(mediaListUrl, accessToken);
  if (!media) {
    console.warn(`[instagram] retry guard could not read media for post ${post.id}; publishing`);
    return null;
  }
  const window = { caption: post.caption, notBeforeMs: retryWindowStart(post), mediaType: publish.mediaType };
  const sameCaption = candidateMedia(media, window, new Set());
  const recorded = sameCaption.length ? await retry.recordedMediaIds(sameCaption.map((item) => item.id)) : new Set<string>();
  if (!recorded) {
    console.warn(`[instagram] retry guard could not read which media are recorded for post ${post.id}; publishing`);
    return null;
  }
  const decision = retryGuardDecision(candidateMedia(media, window, recorded));
  console.log(`[instagram] retry guard: ${decision.kind} for post ${post.id}`);
  return decision.kind === "publish" ? null : decision;
}

/**
 * Publishes an Instagram container (Facebook login). An unanswered request is settled from the
 * container's state, never assumed failed: see instagramPublish.ts.
 */
function publishInstagramMedia(
  igUserId: string,
  creationId: string,
  accessToken: string,
  deferKind?: DeferredKind,
): Promise<{ id: string }> {
  return publishContainer({
    publish: async (timeoutMs) => {
      const response = await fetchWithTimeout(
        `https://graph.facebook.com/v18.0/${igUserId}/media_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
        },
        timeoutMs,
      );
      const reply = await response.json() as GraphResponse;
      console.log("Instagram publish response:", JSON.stringify(reply).slice(0, 300));
      return reply;
    },
    containerState: (timeoutMs) => checkContainerOnce(
      `https://graph.facebook.com/v18.0/${creationId}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
      timeoutMs,
    ),
  }, { creationId, deferKind, requestTimeoutMs: 20000, deadlineMs: workerPublishDeadline(WORKER_STARTED_AT_MS) });
}

/**
 * Post to Instagram (feed posts, Reels, carousels)
 */
async function postToInstagram(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  mediaFiles: MediaFile[],
  timing: PublishTiming = NO_DEFERRAL,
  // Writes the story's own row (answering an error, or null) once it is live and the reel is
  // still to come, so a reel that defers or fails does not lose it. See instagramStory.ts.
  recordStory?: (story: StoryRef) => Promise<string | null>,
  retry: RetryState = NOT_A_RETRY,
  // Writes a failed story row for a retry whose feed post or reel is already done (answering an
  // error, or null).
  recordStoryFailure?: (error: string) => Promise<string | null>,
): Promise<PlatformPostResult> {
  const igUserId = account.platform_user_id;
  const accessToken = account.access_token;
  const username = account.platform_username;

  if (mediaUrls.length === 0) {
    throw new Error("Instagram requires at least one image or video");
  }

  // Get Instagram settings from metadata
  const metadata = post.metadata;
  const rawIgPostType = metadata?.instagram_post_type || "feed";
  // Normalize to array for multi-select support (backward compatible with string)
  const igPostTypes: string[] = Array.isArray(rawIgPostType) ? rawIgPostType : [rawIgPostType];
  const shareToFeed = resolveInstagramShareToFeed(metadata, true);
  const coverThumbnailOffset = metadata?.instagram_cover_thumbnail_offset || 0;
  const audioName = metadata?.instagram_audio_name;
  const collaborator = metadata?.instagram_collaborator;
  // Location: inject if it's a real Facebook Page ID (not osm_ prefixed)
  const igLocationId = metadata?.instagram_location_id;
  const hasIgLocation = igLocationId && !igLocationId.startsWith("osm_");
  const igAltText = metadata?.instagram_alt_text;
  const disableComments = metadata?.instagram_disable_comments === true;
  const shareToStory = metadata?.instagram_share_to_story === true;
  const warnings: string[] = [];

  // ── Location Debug Mode ────────────────────────────────────────────────
  // Auto-on whenever the user touched a location field, or via env / metadata flag.
  // Builds a sanitized debug object that lands in platform_posts.response_data.location_debug.
  const LOCATION_DEBUG_MODE =
    Deno.env.get("LOCATION_DEBUG_MODE") === "true" ||
    (metadata as Record<string, unknown> | undefined)?.location_debug === true ||
    !!(metadata?.instagram_location_id ||
      (metadata as Record<string, unknown> | undefined)?.instagram_location_skipped_reason ||
      metadata?.threads_location_id ||
      (metadata as Record<string, unknown> | undefined)?.threads_location_skipped_reason);

  const locationDebug: Record<string, unknown> = {
    platform: "instagram",
    publish_flow: "facebook_linked",
    selected_location_id: metadata?.instagram_location_id ?? null,
    selected_location_object: (metadata as Record<string, unknown> | undefined)?.instagram_location_object ?? null,
    skipped_reason: (metadata as Record<string, unknown> | undefined)?.instagram_location_skipped_reason ?? null,
    eligibility_check_started: false,
    eligibility_check_result: null as boolean | null,
    eligibility_check_reason: null as string | null,
    media_container_endpoint: null as string | null,
    media_container_body_had_location_id: false,
    media_container_location_id_sent: null as string | null,
    meta_media_create_success: null as boolean | null,
    meta_media_create_error: null as ReturnType<typeof redactMetaError>,
    retry_without_location_attempted: false,
    retry_without_location_success: null as boolean | null,
    post_publish_verify_attempted: false,
    post_publish_verify_result: null as string | null,
    post_publish_verify_error: null as string | null,
    post_publish_location_field: null as unknown,
    final_reason_location_not_visible: null as string | null,
  };

  // Surface frontend-side location skip-reasons so users see why nothing was tagged.
  // The frontend serializer (usePlatformSettings) nulls instagram_location_id when the
  // selected place is reference-only (OSM/Nominatim) or not Instagram-eligible, and
  // records the cause in instagram_location_skipped_reason. We translate that to a
  // user-visible warning here so it shows up in History (response_data.warnings[]).
  {
    const igSkipReason = (metadata as Record<string, unknown> | undefined)?.instagram_location_skipped_reason as
      | string
      | undefined;
    const igLocObj = (metadata as Record<string, unknown> | undefined)?.instagram_location_object as
      | { source?: string }
      | undefined;
    if (igSkipReason && !igLocationId) {
      const reasonMap: Record<string, string> = {
        osm_reference:
          "Instagram location skipped — the selected place is a reference-only result (OpenStreetMap) and Instagram only accepts eligible Meta places.",
        unverified_source:
          "Instagram location skipped — the selected place could not be verified as Instagram-taggable.",
        not_taggable:
          "Instagram location skipped — Meta marked this place as not eligible for Instagram tagging.",
      };
      warnings.push(reasonMap[igSkipReason] || `Instagram location skipped (${igSkipReason}).`);
      // fire-and-forget structured log
      logLocationEvent({
        userId: post.user_id,
        errorCode: "ig_location_skipped_pre_publish",
        level: "info",
        message: `Instagram location skipped pre-publish (${igSkipReason})`,
        details: {
          platform: "instagram",
          social_account_id: account.id,
          post_id: post.id,
          reason: igSkipReason,
          location_object_source: igLocObj?.source ?? null,
        },
      });
    }
  }

  // Helper: check if a Page ID is eligible to be tagged as an Instagram location.
  // Meta silently drops `location_id` on /media when the Page isn't a real "place" Page.
  // We pre-check via Graph API so we can warn the user honestly instead of failing silently.
  let igLocationEligible: boolean | null = null;
  const checkIgLocationEligibility = async (): Promise<boolean> => {
    if (!hasIgLocation) return false;
    if (igLocationEligible !== null) return igLocationEligible;
    locationDebug.eligibility_check_started = true;
    try {
      // Bounded like every request that may run after a publish (a resumed reel's story mirror).
      const data = await followUpGraph(
        `https://graph.facebook.com/v18.0/${igLocationId}?fields=name,location,is_eligible_for_location_tag&access_token=${encodeURIComponent(accessToken)}`
      ) as { name?: string; is_eligible_for_location_tag?: boolean; location?: { latitude?: number; longitude?: number } };
      const loc = data?.location;
      const eligible = data?.is_eligible_for_location_tag === true && loc && (loc.latitude || loc.longitude);
      if (!eligible) {
        const name = data?.name || "this place";
        warnings.push(`Instagram location skipped — '${name}' is not an IG-taggable place. Try a more specific name (e.g. include city).`);
        igLocationEligible = false;
        locationDebug.eligibility_check_result = false;
        locationDebug.eligibility_check_reason = data?.is_eligible_for_location_tag === false ? "not_eligible_flag" : "missing_coordinates";
        logLocationEvent({
          userId: post.user_id,
          errorCode: "ig_location_skipped_pre_publish",
          level: "info",
          message: "Instagram location skipped — not an IG-taggable place",
          details: {
            platform: "instagram",
            social_account_id: account.id,
            post_id: post.id,
            location_id: igLocationId,
            location_name: name,
            meta_endpoint: "/v18.0/{location_id}",
            reason: data?.is_eligible_for_location_tag === false ? "not_eligible_flag" : "missing_coordinates",
          },
        });
        return false;
      }
      igLocationEligible = true;
      locationDebug.eligibility_check_result = true;
      return true;
    } catch (e) {
      warnings.push(`Instagram location check failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      igLocationEligible = false;
      locationDebug.eligibility_check_result = false;
      locationDebug.eligibility_check_reason = "fetch_failed";
      return false;
    }
  };

  // Helper: POST to IG /media with retry-without-location safety net.
  // If Meta rejects the container creation with a location-related error, retry once
  // without `location_id`, push a warning, and emit a structured log.
  const igMediaCreateWithLocationRetry = async (
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<GraphResponse> => {
    const locationAttempted = body.location_id != null;
    // Capture only the FIRST publish-path /media call (the one we care about for debug)
    if (locationDebug.meta_media_create_success === null) {
      locationDebug.media_container_endpoint = "/v18.0/{ig_user_id}/media";
      locationDebug.media_container_body_had_location_id = locationAttempted;
      locationDebug.media_container_location_id_sent = locationAttempted ? String(body.location_id) : null;
    }
    const doFetch = async (b: Record<string, unknown>) => {
      const r = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      }, 20000);
      return await r.json();
    };
    let data = await doFetch(body);
    if (locationDebug.meta_media_create_success === null) {
      locationDebug.meta_media_create_success = !data?.error;
      if (data?.error) locationDebug.meta_media_create_error = redactMetaError(data.error);
    }
    if (
      locationAttempted &&
      data?.error &&
      isIgLocationError(data.error as { message?: string; code?: number; error_subcode?: number })
    ) {
      console.warn(
        `Instagram: location-related error on /media — retrying without location_id (code=${(data.error as { code?: number }).code})`
      );
      const retryBody = { ...body };
      delete retryBody.location_id;
      locationDebug.retry_without_location_attempted = true;
      const retry = await doFetch(retryBody);
      locationDebug.retry_without_location_success = !retry?.error;
      if (!retry?.error) {
        warnings.push("Instagram retried without location after Meta rejected the selected place.");
        logLocationEvent({
          userId: post.user_id,
          errorCode: "ig_location_retry_without",
          level: "warn",
          message: "Instagram /media retried without location",
          details: {
            platform: "instagram",
            social_account_id: account.id,
            post_id: post.id,
            location_id: igLocationId,
            meta_endpoint: "/v18.0/{ig_user_id}/media",
            meta_error_code: (data.error as { code?: number }).code ?? null,
            meta_error_message: safeMetaErrorMessage((data.error as { message?: string }).message),
          },
        });
      }
      data = retry;
    }
    return data;
  };

  // Post-publish verification + final-reason computation. Best-effort, never throws.
  const finalizeIgLocationDebug = async (publishedMediaId: string | null): Promise<Record<string, unknown> | undefined> => {
    if (!LOCATION_DEBUG_MODE) return undefined;

    // Runs after the publish, so it gets only what is left of the worker; none left: not run.
    const verifyTimeoutMs = Math.min(4000, followUpTimeoutMs(WORKER_STARTED_AT_MS, Date.now()));
    if (publishedMediaId && verifyTimeoutMs > 0) {
      locationDebug.post_publish_verify_attempted = true;
      const data = await fetchJsonWithTimeout(
        `https://graph.facebook.com/v18.0/${publishedMediaId}?fields=id,caption,permalink,location&access_token=${encodeURIComponent(accessToken)}`,
        verifyTimeoutMs,
      );
      if (!data) {
        locationDebug.post_publish_verify_result = "verification_failed";
        locationDebug.post_publish_verify_error = "network_or_timeout";
        warnings.push("Instagram published successfully, but location verification failed.");
      } else if (data?.error) {
        const msg = (data.error?.message || "").toLowerCase();
        if (msg.includes("unknown field") || msg.includes("nonexisting field") || msg.includes("does not exist")) {
          locationDebug.post_publish_verify_result = "verification_not_supported";
          warnings.push("Instagram published successfully, but location verification is not supported by the current Meta endpoint.");
        } else {
          locationDebug.post_publish_verify_result = "verification_failed";
          locationDebug.post_publish_verify_error = safeMetaErrorMessage(data.error?.message);
          warnings.push("Instagram published successfully, but location verification failed.");
        }
      } else if (data?.location) {
        locationDebug.post_publish_verify_result = "location_attached";
        locationDebug.post_publish_location_field = data.location;
      } else {
        locationDebug.post_publish_verify_result = "location_missing";
        warnings.push("Instagram published successfully, but Meta did not show the selected location on the final post.");
      }
    }

    // Compute final reason
    const sel = locationDebug.selected_location_id as string | null;
    const skip = locationDebug.skipped_reason as string | null;
    const verify = locationDebug.post_publish_verify_result as string | null;
    let reason: string | null = null;
    if (!sel && !skip) reason = "no_location_selected";
    else if (skip === "osm_reference") reason = "reference_only_osm";
    else if (skip === "not_taggable" || locationDebug.eligibility_check_result === false) reason = "not_taggable_by_meta";
    else if (locationDebug.retry_without_location_attempted) reason = "retried_without_location";
    else if (locationDebug.meta_media_create_success === false) reason = "meta_rejected_location";
    else if (locationDebug.media_container_body_had_location_id === false && sel) reason = "location_id_not_included_in_request";
    else if (verify === "location_missing") reason = "meta_accepted_but_silent_drop";
    else if (verify === "verification_not_supported") reason = "verification_not_supported";
    else if (verify === "verification_failed") reason = "verification_failed";
    else if (verify === "location_attached") reason = null;
    else reason = "unknown";
    locationDebug.final_reason_location_not_visible = reason;

    return locationDebug;
  };

  // Every request after a publish, its body included, is bounded by what is left of the worker,
  // so the live post is still recorded however slow Graph is. No time left, or the time runs
  // out: it throws, and the caller warns.
  const followUpGraph = async (url: string, init: RequestInit = {}): Promise<GraphResponse> => {
    const timeoutMs = followUpTimeoutMs(WORKER_STARTED_AT_MS, Date.now());
    if (!timeoutMs) throw new Error("no time was left before the worker stopped");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return await response.json() as GraphResponse;
    } catch (error) {
      throw controller.signal.aborted ? new Error("Request timed out") : error;
    } finally {
      clearTimeout(timer);
    }
  };

  // Helper: disable comments on a published IG media (Page-flow / Graph API)
  const disableIgComments = async (mediaId: string) => {
    if (!disableComments) return;
    try {
      const data = await followUpGraph(
        `https://graph.facebook.com/v18.0/${mediaId}?comment_enabled=false&access_token=${encodeURIComponent(accessToken)}`,
        { method: "POST" }
      );
      if (data.error) {
        warnings.push(`Disable comments failed: ${data.error.message}`);
      }
    } catch (e) {
      warnings.push(`Disable comments failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  };

  // Helper: post the configured first comment on the published IG media.
  // Mirrors disableIgComments — uses the Facebook Graph API with the Page access
  // token and NEVER throws: a comment failure must not mark already-published
  // media as failed. No-op when no instagram_first_comment is configured.
  const postInstagramFirstComment = async (mediaId: string) => {
    const firstComment = metadata?.instagram_first_comment;
    if (!firstComment) return;
    try {
      const commentData = await followUpGraph(
        `https://graph.facebook.com/v18.0/${mediaId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: firstComment, access_token: accessToken }),
        }
      );
      if (commentData.error) {
        console.error("Instagram first comment error:", commentData.error.message);
        warnings.push(`Instagram first comment failed: ${commentData.error.message}`);
      }
    } catch (e) {
      console.error("Instagram first comment failed:", e);
      warnings.push(`Instagram first comment failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  };

  // Helper: publish first photo/video of a feed/reel post as a Story (mirror toggle)
  // Answers the published Story (id and a link), or null when it was not published.
  const publishIgStoryFromMedia = async (): Promise<StoryRef | null> => {
    try {
      const storyBody: Record<string, unknown> = {
        media_type: "STORIES",
        access_token: accessToken,
      };
      if (mediaType === "VIDEO") storyBody.video_url = mediaUrls[0];
      else storyBody.image_url = mediaUrls[0];
      // Inject location on Story too if eligible
      if (await checkIgLocationEligibility()) {
        storyBody.location_id = igLocationId;
      }
      const createData = await followUpGraph(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(storyBody) }
      );
      if (createData.error) {
        warnings.push(`Also share to Story failed: ${createData.error.message}`);
        return null;
      }
      const storyContainerId = graphId(createData, "Also share to Story");
      // On a resumed run timing.deadlineMs is check-once: that suits the deferred reel, not this
      // container, which nothing re-checks. Give it a real bound.
      // Cut to the worker's publish deadline too: a mirror never outlasts the reel's record.
      await pollContainerStatus(storyContainerId, accessToken, {
        deadlineMs: Math.min(
          ownContainerDeadline(timing.deadlineMs, timing.startedAtMs ?? Date.now()),
          workerPublishDeadline(WORKER_STARTED_AT_MS),
        ),
      });
      const story = await publishInstagramMedia(igUserId, storyContainerId, accessToken);
      console.log("Instagram 'Also share to Story' published successfully");
      return { id: story.id, url: username ? `https://www.instagram.com/stories/${username}/` : "https://instagram.com" };
    } catch (e) {
      warnings.push(`Also share to Story failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      return null;
    }
  };
  let mediaType = "IMAGE";
  if (mediaFiles && mediaFiles.length > 0) {
    const fileType = mediaFiles[0].file_type || (mediaFiles[0].mime_type?.startsWith("video/") ? "video" : "image");
    if (fileType === "video") mediaType = "VIDEO";
  } else if (isVideoUrl(mediaUrls[0])) {
    mediaType = "VIDEO";
  }

  // Force Reel type if user selected it and has video
  const isReel = (igPostTypes.includes("reel") && mediaType === "VIDEO") || mediaType === "VIDEO";

  console.log(`Instagram post: types=${JSON.stringify(igPostTypes)}, mediaType=${mediaType}, isReel=${isReel}, shareToFeed=${shareToFeed}`);

  // A retry of a post already live on the account records it instead of posting it again.
  const profileUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
  const live = await liveOnRetry(post, retry, `https://graph.facebook.com/v18.0/${igUserId}/media`, accessToken, {
    // Nothing to look for when no feed/reel is wanted, or this post's own row already records it.
    storyOnly: igPostTypes.every((type) => type === "story") || retry.feedRecorded === true,
    mediaType: expectedMediaType(mediaType, mediaUrls.length),
  });

  // Handle story separately if included in post types
  const igAllResults: Array<{ id: string; url?: string; warnings?: string[] }> = [];
  // A live story whose row could not be written (even after a retry). If the reel then defers it
  // travels on the pending row, so the resumed or abandoned run writes the missing row.
  let unrecordedStory: StoryRef | null = null;

  // A resumed run finishes only the deferred reel or carousel: the story was handled the first time.
  // A retry posts it again only when no earlier run recorded it.
  if (!timing.resume && !retry.storyRecorded && igPostTypes.includes("story") && mediaUrls.length > 0) {
    const storyBody: Record<string, unknown> = {
      media_type: "STORIES",
      access_token: accessToken,
    };
    if (mediaType === "VIDEO") {
      storyBody.video_url = mediaUrls[0];
    } else {
      storyBody.image_url = mediaUrls[0];
    }
    // Inject location on Story if eligible
    if (await checkIgLocationEligibility()) {
      storyBody.location_id = igLocationId;
    }

    const createResponse = await fetch(
      `https://graph.facebook.com/v18.0/${igUserId}/media`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(storyBody) }
    );
    const createData = await createResponse.json();
    console.log("Instagram Story container:", JSON.stringify(createData).slice(0, 300));

    if (createData.error) {
      warnings.push(`Instagram Story failed: ${createData.error.message}`);
    } else {
      // Poll for container readiness (especially for video stories)
      await pollContainerStatus(createData.id, accessToken, { deadlineMs: timing.deadlineMs });

      // Publish the story
      const publishData = await publishInstagramMedia(igUserId, createData.id, accessToken);

      const mediaResponse = await fetch(
        `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink&access_token=${accessToken}`
      );
      const mediaData = await mediaResponse.json();

      const storyResult = {
        id: publishData.id,
        url: mediaData.permalink || (username ? `https://www.instagram.com/${username}/` : `https://instagram.com`),
        warnings: [],
      };
      igAllResults.push(storyResult);

      // A story-only post returns this result below and the main loop records it. When a
      // reel or feed post follows, it can defer or fail after the story is already live, so
      // the story is recorded now, as the Business-login path does.
      const storyOnly = igPostTypes.length === 1 && igPostTypes[0] === "story";
      if (!storyOnly && recordStory) {
        const story: StoryRef = { id: storyResult.id, url: storyResult.url };
        const recordError = await recordStory(story);
        if (recordError) {
          console.error(`[IG story] published but not recorded: ${recordError}`);
          warnings.push("The Instagram Story was published but could not be recorded.");
          unrecordedStory = story;
        }
      }
    }
  }

  // Both the first run and retries need a durable mirror receipt. Otherwise a retry sees only
  // the feed row and publishes the already-live Story again. Failed receipts travel on that row.
  const publishAndRecordStoryMirror = async () => {
    if (!shareToStory || igPostTypes.includes("story") || retry.storyRecorded) return;
    const mirror = await publishIgStoryFromMedia();
    const recordError = mirror && recordStory ? await recordStory(mirror) : null;
    if (mirror && recordError) {
      console.error(`[IG story] mirror published but not recorded: ${recordError}`);
      warnings.push("The Instagram Story was published but could not be recorded.");
      unrecordedStory = mirror;
    }
  };

  // The story this retry was for failed again, while its feed post or reel is done: the story
  // gets its own failed row, so History shows it and can retry it.
  const storyFailedAgain = igPostTypes.includes("story") && !retry.storyRecorded && igAllResults.length === 0;
  const storyFailure = () => warnings.join("; ") || "Instagram Story failed";

  // This post's own row already records the feed post or reel: it is done, and that row stays the
  // record. What this retry owes is the story.
  if (retry.feedRecorded && !igPostTypes.every((type) => type === "story")) {
    await publishAndRecordStoryMirror();
    // As in Business Login, the recorded feed post or reel still counts as the account's success.
    // A failed row that could not be written must not be reported as written.
    if (storyFailedAgain) {
      const error = storyFailure();
      const writeError = recordStoryFailure ? await recordStoryFailure(error) : null;
      if (writeError) throw new Error(`${error} (and its failed row could not be recorded: ${writeError})`);
      return {
        selfWroteRows: true,
        subResults: [{ subtype: "story", status: "failed", error }, { subtype: "feed", status: "success" }],
        warnings,
      } as PlatformPostResult;
    }
    // A live story without its own row goes to the main loop, which records and logs it.
    if (unrecordedStory) return { id: unrecordedStory.id, url: unrecordedStory.url, warnings, ...{ unrecorded_story: unrecordedStory } };
    return { selfWroteRows: true, subResults: [{ subtype: "feed", status: "success" }], warnings } as PlatformPostResult;
  }

  // The feed post or reel is already live: recorded, not posted again (the story step above ran).
  if (live) {
    // Its publish went unanswered, so the run that published it never mirrored it to the Story.
    await publishAndRecordStoryMirror();
    if (storyFailedAgain && recordStoryFailure) {
      // As on the recorded-feed path, a failed row that could not be written fails the account, so
      // the main loop writes its fallback row and the story stays retryable. The next retry finds
      // the live feed post or reel again through the guard.
      const error = storyFailure();
      const writeError = await recordStoryFailure(error);
      if (writeError) throw new Error(`${error} (and its failed row could not be recorded: ${writeError})`);
    }
    const carried = unrecordedStory ? { unrecorded_story: unrecordedStory } : {};
    return live.kind === "already_live"
      ? { id: live.media.id, url: live.media.permalink ?? profileUrl, warnings: [...warnings, ALREADY_LIVE_MESSAGE], ...(isReel ? { publicationSubtype: "reel" as const } : {}), ...carried }
      : { url: profileUrl, warnings: [...warnings, alreadyLiveCopiesMessage(live.count)], ...carried };
  }

  // If only story was selected, return the story result
  if (igPostTypes.length === 1 && igPostTypes[0] === "story") {
    if (igAllResults.length > 0) {
      return { ...igAllResults[0], warnings };
    }
    // Story failed but was the only type
    throw new Error(warnings.join("; ") || "Instagram Story failed");
  }

  // Continue with feed/reel logic for remaining post types
  const postType = igPostTypes.includes("reel") ? "reel" : "feed";

  // Location is display-only metadata

  // Optimize image URLs for Instagram's crawler (Cloudinary → JPEG)
  const optimizedMediaUrls = await optimizeUrlsForInstagram(mediaUrls);

  if (isReel) {
    // ─────────────────────────────────────────────────────────────────────
    // Instagram Reels Post (uses video_url, no optimization needed)
    // ─────────────────────────────────────────────────────────────────────
    const reelsBody: Record<string, unknown> = {
      media_type: "REELS",
      video_url: mediaUrls[0],
      caption: post.caption,
      share_to_feed: shareToFeed,
      access_token: accessToken,
    };

    // Add cover thumbnail offset (in milliseconds)
    if (coverThumbnailOffset > 0) {
      reelsBody.thumb_offset = coverThumbnailOffset;
    }

    // Add audio name for original audio
    if (audioName) {
      reelsBody.audio_name = audioName;
    }

    // Add collaborator if specified
    if (collaborator) {
      const cleanCollaborator = collaborator.replace("@", "").trim();
      if (cleanCollaborator) {
        reelsBody.collaborators = [cleanCollaborator];
      }
    }

    // Add location if eligible (pre-checked via Graph API to avoid silent drop)
    if (await checkIgLocationEligibility()) {
      reelsBody.location_id = igLocationId;
    }

    // A resumed run already has the container; creating another would publish twice.
    let reelContainerId: string;
    if (timing.resume) {
      reelContainerId = timing.resume.deferral.container_id;
      // The first run published a story it could not record: record it now (the story itself
      // is never published again).
      const carried = timing.resume.unrecordedStory;
      if (carried && recordStory) {
        const recordError = await recordStory(carried);
        if (recordError) {
          console.error(`[IG story] still not recorded on resume: ${recordError}`);
          warnings.push("The Instagram Story was published but could not be recorded.");
          unrecordedStory = carried;
        }
      }
    } else {
      console.log("Instagram REELS request:", JSON.stringify(reelsBody).slice(0, 500));

      let createData = await igMediaCreateWithLocationRetry(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        reelsBody,
      );
      // After a location-retry, body may have been stripped; mirror that on the local body.
      if (createData && !("error" in (createData as object)) && reelsBody.location_id && !("location_id" in reelsBody)) {
        // no-op — kept for clarity; helper already pushed the warning.
      }
      console.log("Instagram REELS creation response:", JSON.stringify(createData).slice(0, 300));

      // Retry without collaborator if "User not visible" error
      if (createData.error && reelsBody.collaborators && (createData.error.code === 210 || createData.error.message?.includes("not visible"))) {
        const skippedCollaborator = (reelsBody.collaborators as string[])[0];
        console.warn("Collaborator rejected by Instagram API, retrying without collaborator:", createData.error.message);
        delete reelsBody.collaborators;
        warnings.push(`Collaborator @${skippedCollaborator} was skipped — their account must be a Business or Creator account to accept API collaboration invites`);
        createData = await igMediaCreateWithLocationRetry(
          `https://graph.facebook.com/v18.0/${igUserId}/media`,
          reelsBody,
        );
        console.log("Instagram REELS retry response:", JSON.stringify(createData).slice(0, 300));
      }

      if (createData.error) throw new Error(createData.error.message);
      reelContainerId = String(createData.id);
    }

    // Poll for container status before publishing (Required for videos)
    let reelStatus: string;
    try {
      reelStatus = await pollContainerStatus(reelContainerId, accessToken, {
        deferKind: "ig_reel",
        deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS),
      }, 60, 2000);
    } catch (waitError) {
      // The pending row carries a story that could not be recorded, or it would be lost here.
      if (waitError instanceof ContainerStillProcessing && unrecordedStory) waitError.unrecordedStory = unrecordedStory;
      throw waitError;
    }
    let publishData: { id: string };
    if (reelStatus === "PUBLISHED") {
      // Only a resumed run sees this: an earlier run's publish went unanswered, or its worker
      // stopped, after Instagram published.
      // The container id is not the media id (analytics would read it as one): find the media.
      const firstDeferredAt = Date.parse(timing.resume?.deferral.first_deferred_at ?? "");
      const media = await findPublishedMedia(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        accessToken,
        post.caption,
        (Number.isFinite(firstDeferredAt) ? firstDeferredAt : Date.now()) - PUBLISHED_LOOKBACK_MS,
      );
      if (!media) {
        return {
          url: username ? `https://www.instagram.com/${username}/` : `https://instagram.com`,
          warnings: [
            ...warnings,
            "Instagram had already published this reel, but it could not be identified, so its first comment, comment setting and story share were not applied.",
          ],
          ...(unrecordedStory ? { unrecorded_story: unrecordedStory } : {}),
        };
      }
      publishData = { id: media.id };
    } else {
      // A publish Instagram did not confirm is left for the reconciler, carrying the unrecorded
      // story like the wait above.
      try {
        publishData = await publishInstagramMedia(igUserId, reelContainerId, accessToken, "ig_reel");
      } catch (publishError) {
        if (publishError instanceof ContainerStillProcessing && unrecordedStory) publishError.unrecordedStory = unrecordedStory;
        throw publishError;
      }
    }

    // On a resumed run they may have run once already, before a worker stopped: never twice.
    const followUps = await claimFollowUps(timing.resume);
    if (followUps) {
      await postInstagramFirstComment(publishData.id);
      await disableIgComments(publishData.id);
    } else {
      warnings.push("This reel's first comment, comment setting and story share were not run on this attempt, so that they can never run twice.");
    }

    // Get the permalink for the Reel (best effort: the reel is live with or without it)
    let postUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
    try {
      const mediaData = await followUpGraph(
        `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink,shortcode&access_token=${accessToken}`
      );
      if (typeof mediaData.permalink === "string" && mediaData.permalink) {
        postUrl = mediaData.permalink;
      } else if (typeof mediaData.shortcode === "string" && mediaData.shortcode) {
        postUrl = `https://www.instagram.com/reel/${mediaData.shortcode}/`;
      }
    } catch (e) {
      console.warn("Instagram reel permalink could not be read:", e instanceof Error ? e.message : e);
    }

    // Mirror to Story if toggle is on (and Story wasn't already in post types)
    if (followUps && shareToStory && !igPostTypes.includes("story")) {
      await publishAndRecordStoryMirror();
    }

    const reelDebug = await finalizeIgLocationDebug(publishData.id);
    return {
      id: publishData.id,
      url: postUrl,
      warnings,
      ...(reelDebug ? { location_debug: reelDebug } : {}),
      publicationSubtype: "reel",
      // A live reel settles now; a story still unrecorded is kept on its row, never held over it.
      ...(unrecordedStory ? { unrecorded_story: unrecordedStory } : {}),
    };

  } else if (mediaUrls.length === 1) {
    // ─────────────────────────────────────────────────────────────────────
    // Single Image Post
    // ─────────────────────────────────────────────────────────────────────
    const imageBody: Record<string, unknown> = {
      image_url: optimizedMediaUrls[0],
      caption: post.caption,
      access_token: accessToken,
    };

    // Add collaborator for feed posts too
    if (collaborator) {
      const cleanCollaborator = collaborator.replace("@", "").trim();
      if (cleanCollaborator) {
        imageBody.collaborators = [cleanCollaborator];
      }
    }

    // Add location if eligible (pre-checked via Graph API to avoid silent drop)
    if (await checkIgLocationEligibility()) {
      imageBody.location_id = igLocationId;
    }

    // Add alt text (image containers only)
    if (igAltText) {
      imageBody.alt_text = igAltText;
    }

    let createData = await igMediaCreateWithLocationRetry(
      `https://graph.facebook.com/v18.0/${igUserId}/media`,
      imageBody,
    );
    console.log("Instagram container creation response:", JSON.stringify(createData).slice(0, 300));

    // Retry without collaborator if "User not visible" error
    if (createData.error && imageBody.collaborators && (createData.error.code === 210 || createData.error.message?.includes("not visible"))) {
      const skippedCollaborator = (imageBody.collaborators as string[])[0];
      console.warn("Collaborator rejected by Instagram API, retrying without collaborator:", createData.error.message);
      delete imageBody.collaborators;
      warnings.push(`Collaborator @${skippedCollaborator} was skipped — their account must be a Business or Creator account to accept API collaboration invites`);
      createData = await igMediaCreateWithLocationRetry(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        imageBody,
      );
      console.log("Instagram image retry response:", JSON.stringify(createData).slice(0, 300));
    }

    if (createData.error) throw new Error(createData.error.message);
    const containerId = graphId(createData, "Instagram image container");

    // Poll for container status before publishing
    await pollContainerStatus(containerId, accessToken, { deadlineMs: timing.deadlineMs });

    // Publish the media with retry logic
    const publishData = await publishInstagramMedia(igUserId, containerId, accessToken);

    // Post first comment
    await postInstagramFirstComment(publishData.id);
    await disableIgComments(publishData.id);

    // Get the permalink and shortcode for the published post
    const mediaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink,shortcode&access_token=${accessToken}`
    );
    const mediaData = await mediaResponse.json();
    console.log("Instagram media data:", JSON.stringify(mediaData).slice(0, 300));

    // Extract shortcode from permalink or use the shortcode field
    let shortcode = mediaData.shortcode;
    if (!shortcode && mediaData.permalink) {
      const match = mediaData.permalink.match(/\/p\/([A-Za-z0-9_-]+)/);
      shortcode = match ? match[1] : null;
    }

    // Mirror to Story if toggle is on (and Story wasn't already in post types)
    if (shareToStory && !igPostTypes.includes("story")) {
      await publishAndRecordStoryMirror();
    }

    const singleDebug = await finalizeIgLocationDebug(publishData.id);
    return {
      id: shortcode || publishData.id,
      url: username && shortcode
        ? `https://www.instagram.com/${username}/p/${shortcode}/`
        : mediaData.permalink || `https://instagram.com`,
      warnings,
      ...(singleDebug ? { location_debug: singleDebug } : {}),
      ...(unrecordedStory ? { unrecorded_story: unrecordedStory } : {}),
    };

  } else {
    // ─────────────────────────────────────────────────────────────────────
    // Carousel Post (2-10 images)
    // ─────────────────────────────────────────────────────────────────────
    // A resumed run already has the carousel container; creating another would publish twice.
    let carouselId: string;
    if (timing.resume) {
      carouselId = timing.resume.deferral.container_id;
      // The first run published a story it could not record: record it now (the story itself
      // is never published again).
      const carried = timing.resume.unrecordedStory;
      if (carried && recordStory) {
        const recordError = await recordStory(carried);
        if (recordError) {
          console.error(`[IG story] still not recorded on resume: ${recordError}`);
          warnings.push("The Instagram Story was published but could not be recorded.");
          unrecordedStory = carried;
        }
      }
    } else {
      const childEndpoint = `https://graph.facebook.com/v18.0/${igUserId}/media`;
      const containerIds = await createCarouselChildren(
        optimizedMediaUrls.slice(0, 10),
        (url) => ({ image_url: url, is_carousel_item: true, access_token: accessToken, ...(igAltText ? { alt_text: igAltText } : {}) }),
        async (childBody) => {
          // Bounded like every other Meta call: ten parallel creates cannot hang the worker.
          const response = await fetchWithTimeout(childEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(childBody) }, 20000);
          return await response.json();
        },
      );
      // The children share the carousel's deferrable budget so the publish still fits the worker.
      const children = await waitForCarouselChildren(
        "instagram",
        containerIds,
        (id) => `https://graph.facebook.com/v18.0/${id}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
        { deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS), maxAttempts: 30, intervalMs: 2000 },
      );
      // Instagram refuses a carousel missing a child, so one failed child fails the carousel.
      if (children.dropped.length > 0) throw new Error(containerFailureMessage("instagram", children.dropped[0].reason));

      const carouselBody: Record<string, unknown> = {
        media_type: "CAROUSEL",
        children: children.finished.join(","),
        caption: post.caption,
        access_token: accessToken,
      };

      // Add collaborator for carousel posts too
      if (collaborator) {
        const cleanCollaborator = collaborator.replace("@", "").trim();
        if (cleanCollaborator) {
          carouselBody.collaborators = [cleanCollaborator];
        }
      }

      // Add location if eligible (pre-checked via Graph API to avoid silent drop)
      if (await checkIgLocationEligibility()) {
        carouselBody.location_id = igLocationId;
      }

      let carouselData = await igMediaCreateWithLocationRetry(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        carouselBody,
      );

      // Retry without collaborator if "User not visible" error
      if (carouselData.error && carouselBody.collaborators && (carouselData.error.code === 210 || carouselData.error.message?.includes("not visible"))) {
        const skippedCollaborator = (carouselBody.collaborators as string[])[0];
        console.warn("Collaborator rejected by Instagram API, retrying without collaborator:", carouselData.error.message);
        delete carouselBody.collaborators;
        warnings.push(`Collaborator @${skippedCollaborator} was skipped — their account must be a Business or Creator account to accept API collaboration invites`);
        carouselData = await igMediaCreateWithLocationRetry(
          `https://graph.facebook.com/v18.0/${igUserId}/media`,
          carouselBody,
        );
      }

      if (carouselData.error) throw new Error(carouselData.error.message);
      carouselId = graphId(carouselData, "Instagram carousel container");
    }

    // The carousel can be finished later like a reel: the reconciler resumes a still-processing one.
    let carouselStatus: string;
    try {
      carouselStatus = await pollContainerStatus(carouselId, accessToken, {
        deferKind: "ig_carousel",
        deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS),
      });
    } catch (waitError) {
      // The pending row carries a story that could not be recorded, or it would be lost here.
      if (waitError instanceof ContainerStillProcessing && unrecordedStory) waitError.unrecordedStory = unrecordedStory;
      throw waitError;
    }
    let publishData: { id: string };
    if (carouselStatus === "PUBLISHED") {
      // Only a resumed run sees this: an earlier run's publish went unanswered, or its worker
      // stopped, after Instagram published. The container id is not the media id: find the media.
      const firstDeferredAt = Date.parse(timing.resume?.deferral.first_deferred_at ?? "");
      const media = await findPublishedMedia(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        accessToken,
        post.caption,
        (Number.isFinite(firstDeferredAt) ? firstDeferredAt : Date.now()) - PUBLISHED_LOOKBACK_MS,
      );
      if (!media) {
        return {
          url: username ? `https://www.instagram.com/${username}/` : `https://instagram.com`,
          warnings: [...warnings, "Instagram had already published this carousel, but it could not be identified, so its first comment, comment setting and story share were not applied."],
          ...(unrecordedStory ? { unrecorded_story: unrecordedStory } : {}),
        };
      }
      publishData = { id: media.id };
    } else {
      // A publish Instagram did not confirm is left for the reconciler, carrying the unrecorded
      // story like the wait above.
      try {
        publishData = await publishInstagramMedia(igUserId, carouselId, accessToken, "ig_carousel");
      } catch (publishError) {
        if (publishError instanceof ContainerStillProcessing && unrecordedStory) publishError.unrecordedStory = unrecordedStory;
        throw publishError;
      }
    }

    // On a resumed run they may have run once already, before a worker stopped: never twice.
    const followUps = await claimFollowUps(timing.resume);
    if (followUps) {
      await postInstagramFirstComment(publishData.id);
      await disableIgComments(publishData.id);
    }

    // Get the permalink
    const mediaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink&access_token=${accessToken}`
    );
    const mediaData = await mediaResponse.json();

    // Mirror to Story if toggle is on (and Story wasn't already in post types)
    if (followUps && shareToStory && !igPostTypes.includes("story")) {
      await publishAndRecordStoryMirror();
    }

    const carouselDebug = await finalizeIgLocationDebug(publishData.id);
    return {
      id: publishData.id,
      url: mediaData.permalink || `https://instagram.com`,
      warnings,
      ...(carouselDebug ? { location_debug: carouselDebug } : {}),
      ...(unrecordedStory ? { unrecorded_story: unrecordedStory } : {}),
    };
  }
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.3b INSTAGRAM BUSINESS LOGIN (Direct)                                  │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Poll Instagram Business Login container status
 * Uses graph.instagram.com instead of graph.facebook.com
 */
function pollBusinessLoginContainerStatus(
  containerId: string,
  accessToken: string,
  wait: ContainerWait,
  maxAttempts = 30,
  delayMs = 2000,
): Promise<string> {
  return waitForInstagramContainer(
    `https://graph.instagram.com/v22.0/${containerId}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
    containerId,
    maxAttempts,
    delayMs,
    wait,
  );
}

/**
 * Publishes an Instagram Business Login container (graph.instagram.com). An unanswered request
 * is settled from the container's state, never assumed failed: see instagramPublish.ts.
 */
function publishBusinessLoginMedia(
  igUserId: string,
  creationId: string,
  accessToken: string,
  deferKind?: DeferredKind,
): Promise<{ id: string }> {
  return publishContainer({
    publish: async (timeoutMs) => {
      const response = await fetchWithTimeout(
        `https://graph.instagram.com/v22.0/${igUserId}/media_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
        },
        timeoutMs,
      );
      const reply = await response.json() as GraphResponse;
      console.log("BL Instagram publish response:", JSON.stringify(reply).slice(0, 300));
      return reply;
    },
    containerState: (timeoutMs) => checkContainerOnce(
      `https://graph.instagram.com/v22.0/${creationId}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
      timeoutMs,
    ),
  }, { creationId, deferKind, requestTimeoutMs: 30000, deadlineMs: workerPublishDeadline(WORKER_STARTED_AT_MS) });
}

/**
 * Post to Instagram via Business Login (Direct)
 * Uses graph.instagram.com endpoints instead of graph.facebook.com
 * Uses account.access_token directly (no page_access_token needed)
 * @updated 2026-04-09 - force redeploy
 */
async function postToInstagramBusinessLogin(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  mediaFiles: MediaFile[],
  supabase: SupabaseClient,
  postId: string,
  timing: PublishTiming = NO_DEFERRAL,
  retry: RetryState = NOT_A_RETRY,
  recordResultId?: (id: string | null) => void,
): Promise<PlatformPostResult> {
  const igUserId = account.platform_user_id;
  const accessToken = account.access_token;
  const username = account.platform_username;

  if (mediaUrls.length === 0) {
    throw new Error("Instagram requires at least one image or video");
  }

  const metadata = post.metadata;
  const rawBLPostType = metadata?.instagram_post_type || "feed";
  const blPostTypes: string[] = Array.isArray(rawBLPostType) ? rawBLPostType : [rawBLPostType];
  const coverThumbnailOffset = metadata?.instagram_cover_thumbnail_offset || 0;
  const audioName = metadata?.instagram_audio_name;
  const collaborator = metadata?.instagram_collaborator;
  const instagramLocationId = metadata?.instagram_location_id;
  const hasValidLocation = instagramLocationId && typeof instagramLocationId === "string" && !instagramLocationId.startsWith("osm_");
  const igAltText = metadata?.instagram_alt_text;
  const disableComments = metadata?.instagram_disable_comments === true;
  const shareToStory = metadata?.instagram_share_to_story === true;
  const warnings: string[] = [];
  const subResults: NonNullable<PlatformPostResult["subResults"]> = [];

  // ── Location Debug Mode (Business Login flow) ──────────────────────────
  const LOCATION_DEBUG_MODE =
    Deno.env.get("LOCATION_DEBUG_MODE") === "true" ||
    (metadata as Record<string, unknown> | undefined)?.location_debug === true ||
    !!(metadata?.instagram_location_id ||
      (metadata as Record<string, unknown> | undefined)?.instagram_location_skipped_reason);

  const locationDebug: Record<string, unknown> = {
    platform: "instagram",
    publish_flow: "business_login",
    selected_location_id: metadata?.instagram_location_id ?? null,
    selected_location_object: (metadata as Record<string, unknown> | undefined)?.instagram_location_object ?? null,
    skipped_reason: (metadata as Record<string, unknown> | undefined)?.instagram_location_skipped_reason ?? null,
    eligibility_check_started: false,
    eligibility_check_result: null as boolean | null,
    eligibility_check_reason: null as string | null,
    media_container_endpoint: null as string | null,
    media_container_body_had_location_id: false,
    media_container_location_id_sent: null as string | null,
    meta_media_create_success: null as boolean | null,
    meta_media_create_error: null as ReturnType<typeof redactMetaError>,
    retry_without_location_attempted: false,
    retry_without_location_success: null as boolean | null,
    post_publish_verify_attempted: false,
    post_publish_verify_result: null as string | null,
    post_publish_verify_error: null as string | null,
    post_publish_location_field: null as unknown,
    final_reason_location_not_visible: null as string | null,
  };

  // Surface frontend-side location skip-reasons (same as Page-flow).
  {
    const igSkipReason = (metadata as Record<string, unknown> | undefined)?.instagram_location_skipped_reason as
      | string
      | undefined;
    const igLocObj = (metadata as Record<string, unknown> | undefined)?.instagram_location_object as
      | { source?: string }
      | undefined;
    if (igSkipReason && !instagramLocationId) {
      const reasonMap: Record<string, string> = {
        osm_reference:
          "Instagram location skipped — the selected place is a reference-only result (OpenStreetMap) and Instagram only accepts eligible Meta places.",
        unverified_source:
          "Instagram location skipped — the selected place could not be verified as Instagram-taggable.",
        not_taggable:
          "Instagram location skipped — Meta marked this place as not eligible for Instagram tagging.",
      };
      warnings.push(reasonMap[igSkipReason] || `Instagram location skipped (${igSkipReason}).`);
      logLocationEvent({
        userId: post.user_id,
        errorCode: "ig_location_skipped_pre_publish",
        level: "info",
        message: `Instagram (Business Login) location skipped pre-publish (${igSkipReason})`,
        details: {
          platform: "instagram",
          social_account_id: account.id,
          post_id: post.id,
          reason: igSkipReason,
          location_object_source: igLocObj?.source ?? null,
        },
      });
    }
  }

  // Detect media type
  let mediaType = "IMAGE";
  if (mediaFiles && mediaFiles.length > 0) {
    const fileType = mediaFiles[0].file_type || (mediaFiles[0].mime_type?.startsWith("video/") ? "video" : "image");
    if (fileType === "video") mediaType = "VIDEO";
  } else if (isVideoUrl(mediaUrls[0])) {
    mediaType = "VIDEO";
  }

  console.log(`Instagram BL post: types=${JSON.stringify(blPostTypes)}, mediaType=${mediaType}`);

  // ─── Helpers ───────────────────────────────────────────────────────────────
  let blLocationEligible: boolean | null = null;
  const checkBLLocationEligibility = async (): Promise<boolean> => {
    if (!hasValidLocation) return false;
    if (blLocationEligible !== null) return blLocationEligible;
    locationDebug.eligibility_check_started = true;
    try {
      const res = await fetch(
        `https://graph.instagram.com/v22.0/${instagramLocationId}?fields=name,location,is_eligible_for_location_tag&access_token=${encodeURIComponent(accessToken)}`
      );
      const data = await res.json();
      const loc = data?.location;
      const eligible = data?.is_eligible_for_location_tag === true && loc && (loc.latitude || loc.longitude);
      if (!eligible) {
        const name = data?.name || "this place";
        warnings.push(`Instagram location skipped — '${name}' is not an IG-taggable place.`);
        blLocationEligible = false;
        locationDebug.eligibility_check_result = false;
        locationDebug.eligibility_check_reason = data?.is_eligible_for_location_tag === false ? "not_eligible_flag" : "missing_coordinates";
        logLocationEvent({
          userId: post.user_id,
          errorCode: "ig_location_skipped_pre_publish",
          level: "info",
          message: "Instagram (Business Login) location skipped — not an IG-taggable place",
          details: {
            platform: "instagram",
            social_account_id: account.id,
            post_id: post.id,
            location_id: instagramLocationId,
            location_name: name,
            meta_endpoint: "/v22.0/{location_id}",
            reason: data?.is_eligible_for_location_tag === false ? "not_eligible_flag" : "missing_coordinates",
          },
        });
        return false;
      }
      blLocationEligible = true;
      locationDebug.eligibility_check_result = true;
      return true;
    } catch (e) {
      warnings.push(`Instagram location check failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      blLocationEligible = false;
      locationDebug.eligibility_check_result = false;
      locationDebug.eligibility_check_reason = "fetch_failed";
      return false;
    }
  };

  // Helper: POST to Business-Login /media with retry-without-location safety net.
  // Mirrors igMediaCreateWithLocationRetry from the Page-flow but targets graph.instagram.com.
  const blMediaCreateWithLocationRetry = async (
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<GraphResponse> => {
    const locationAttempted = body.location_id != null;
    if (locationDebug.meta_media_create_success === null) {
      locationDebug.media_container_endpoint = "/v22.0/{ig_user_id}/media";
      locationDebug.media_container_body_had_location_id = locationAttempted;
      locationDebug.media_container_location_id_sent = locationAttempted ? String(body.location_id) : null;
    }
    const doFetch = async (b: Record<string, unknown>) => {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      return await r.json();
    };
    let data = await doFetch(body);
    if (locationDebug.meta_media_create_success === null) {
      locationDebug.meta_media_create_success = !data?.error;
      if (data?.error) locationDebug.meta_media_create_error = redactMetaError(data.error);
    }
    if (
      locationAttempted &&
      data?.error &&
      isIgLocationError(data.error as { message?: string; code?: number; error_subcode?: number })
    ) {
      console.warn(
        `Instagram (BL): location-related error on /media — retrying without location_id (code=${(data.error as { code?: number }).code})`
      );
      const retryBody = { ...body };
      delete retryBody.location_id;
      locationDebug.retry_without_location_attempted = true;
      const retry = await doFetch(retryBody);
      locationDebug.retry_without_location_success = !retry?.error;
      if (!retry?.error) {
        warnings.push("Instagram retried without location after Meta rejected the selected place.");
        logLocationEvent({
          userId: post.user_id,
          errorCode: "ig_location_retry_without",
          level: "warn",
          message: "Instagram (Business Login) /media retried without location",
          details: {
            platform: "instagram",
            social_account_id: account.id,
            post_id: post.id,
            location_id: instagramLocationId,
            meta_endpoint: "/v22.0/{ig_user_id}/media",
            meta_error_code: (data.error as { code?: number }).code ?? null,
            meta_error_message: safeMetaErrorMessage((data.error as { message?: string }).message),
          },
        });
      }
      data = retry;
    }
    return data;
  };

  // Post-publish verify + final-reason for Business Login. Best-effort, never throws.
  const finalizeBLLocationDebug = async (publishedMediaId: string | null): Promise<Record<string, unknown> | undefined> => {
    if (!LOCATION_DEBUG_MODE) return undefined;
    if (publishedMediaId) {
      locationDebug.post_publish_verify_attempted = true;
      const data = await fetchJsonWithTimeout(
        `https://graph.instagram.com/v22.0/${publishedMediaId}?fields=id,caption,permalink,location&access_token=${encodeURIComponent(accessToken)}`,
      );
      if (!data) {
        locationDebug.post_publish_verify_result = "verification_failed";
        locationDebug.post_publish_verify_error = "network_or_timeout";
        warnings.push("Instagram published successfully, but location verification failed.");
      } else if (data?.error) {
        const msg = (data.error?.message || "").toLowerCase();
        if (msg.includes("unknown field") || msg.includes("nonexisting field") || msg.includes("does not exist")) {
          locationDebug.post_publish_verify_result = "verification_not_supported";
          warnings.push("Instagram published successfully, but location verification is not supported by the current Meta endpoint.");
        } else {
          locationDebug.post_publish_verify_result = "verification_failed";
          locationDebug.post_publish_verify_error = safeMetaErrorMessage(data.error?.message);
          warnings.push("Instagram published successfully, but location verification failed.");
        }
      } else if (data?.location) {
        locationDebug.post_publish_verify_result = "location_attached";
        locationDebug.post_publish_location_field = data.location;
      } else {
        locationDebug.post_publish_verify_result = "location_missing";
        warnings.push("Instagram published successfully, but Meta did not show the selected location on the final post.");
      }
    }
    const sel = locationDebug.selected_location_id as string | null;
    const skip = locationDebug.skipped_reason as string | null;
    const verify = locationDebug.post_publish_verify_result as string | null;
    let reason: string | null = null;
    if (!sel && !skip) reason = "no_location_selected";
    else if (skip === "osm_reference") reason = "reference_only_osm";
    else if (skip === "not_taggable" || locationDebug.eligibility_check_result === false) reason = "not_taggable_by_meta";
    else if (locationDebug.retry_without_location_attempted) reason = "retried_without_location";
    else if (locationDebug.meta_media_create_success === false) reason = "meta_rejected_location";
    else if (locationDebug.media_container_body_had_location_id === false && sel) reason = "location_id_not_included_in_request";
    else if (verify === "location_missing") reason = "meta_accepted_but_silent_drop";
    else if (verify === "verification_not_supported") reason = "verification_not_supported";
    else if (verify === "verification_failed") reason = "verification_failed";
    else if (verify === "location_attached") reason = null;
    else reason = "unknown";
    locationDebug.final_reason_location_not_visible = reason;
    return locationDebug;
  };

  const disableBLComments = async (mediaId: string) => {
    if (!disableComments) return;
    try {
      await fetch(
        `https://graph.instagram.com/v22.0/${mediaId}?comment_enabled=false&access_token=${encodeURIComponent(accessToken)}`,
        { method: "POST" }
      );
    } catch (e) {
      console.warn("Disable comments failed:", e);
    }
  };

  const postBLFirstComment = async (mediaId: string) => {
    const firstComment = metadata?.instagram_first_comment;
    if (!firstComment) return;
    try {
      await fetch(
        `https://graph.instagram.com/v22.0/${mediaId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: firstComment, access_token: accessToken }),
        }
      );
    } catch (e) {
      console.warn("First comment failed:", e);
    }
  };

  // Insert a platform_posts row immediately for one IG sub-post and return its DB id
  const insertIGRow = async (
    subtype: "story" | "reel" | "feed",
    status: "success" | "failed",
    mediaId?: string,
    postUrl?: string,
    errorMessage?: string,
    extraData?: Record<string, unknown> & { warnings?: string[] }
  ): Promise<string | null> => {
    try {
      const rowWarnings = [...warnings, ...(extraData?.warnings ?? [])];
      // One Instagram post can be several sub-posts (story, reel, feed), each
      // its own target with its own row -- so each is its own occurrence, and
      // keying the event on the POST id rather than the row id would collapse
      // them into one.
      const settled = await settlePlatformPost(supabase, {
        // A resumed run settles the pending row the first run left; only the reel or carousel resumes.
        platformPostId: subtype !== "story" ? timing.resume?.platformPostId ?? null : null,
        postId,
        socialAccountId: account.id,
        platform: "instagram",
        status,
        providerPostId: mediaId || null,
        providerPostUrl: postUrl || null,
        errorMessage: errorMessage || null,
        responseData: {
          ig_post_subtype: subtype,
          account_username: account.platform_username,
          account_metadata: account.account_metadata,
          ...(extraData || {}),
          ...(rowWarnings.length > 0 ? { warnings: rowWarnings } : {}),
        },
      });
      if (settled.error) {
        console.error(`[IG ${subtype}] settle failed:`, settled.error);
        recordResultId?.(null);
        return null;
      }
      console.log(`[IG ${subtype}] platform_posts row settled: ${settled.id} (status=${status})`);
      recordResultId?.(settled.id);
      return settled.id;
    } catch (e) {
      console.error(`[IG ${subtype}] insert exception:`, e);
      recordResultId?.(null);
      return null;
    }
  };

  // Background: enrich a freshly-published IG media (permalink + first comment + disable comments)
  const enrichInBackground = (
    rowId: string | null,
    mediaId: string,
    subtype: "story" | "reel" | "feed",
    fallbackUrl: string
  ) => {
    const work = (async () => {
      try {
        const fields = subtype === "reel" ? "permalink,shortcode" : "permalink";
        const mediaResponse = await fetch(
          `https://graph.instagram.com/v22.0/${mediaId}?fields=${fields}&access_token=${accessToken}`
        );
        const mediaData = await mediaResponse.json();
        let finalUrl = fallbackUrl;
        if (mediaData?.permalink) finalUrl = mediaData.permalink;
        else if (mediaData?.shortcode) finalUrl = `https://www.instagram.com/reel/${mediaData.shortcode}/`;

        if (rowId && finalUrl !== fallbackUrl) {
          await supabase
            .from("platform_posts")
            .update({ platform_post_url: finalUrl })
            .eq("id", rowId);
        }
        await postBLFirstComment(mediaId);
        await disableBLComments(mediaId);
      } catch (e) {
        console.warn(`[IG ${subtype}] background enrichment failed:`, e);
      }
    })();
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(work);
    }
  };

  // A retry of a post already live on the account records it instead of posting it again.
  const live = await liveOnRetry(post, retry, `https://graph.instagram.com/v22.0/${igUserId}/media`, accessToken, {
    // Nothing to look for when no feed/reel is wanted, or this post's own row already records it.
    storyOnly: (!blPostTypes.includes("feed") && !blPostTypes.includes("reel")) || retry.feedRecorded === true,
    mediaType: expectedMediaType(mediaType, mediaUrls.length),
  });
  const optimizedMediaUrls = await optimizeUrlsForInstagram(mediaUrls);

  // ─── 1. STORY ──────────────────────────────────────────────────────────────
  const wantStory = blPostTypes.includes("story") || (shareToStory && mediaUrls.length > 0);
  // A resumed run finishes only the deferred reel or carousel: the story was handled the first time.
  // A retry posts it again only when no earlier run recorded it.
  if (wantStory && !timing.resume && !retry.storyRecorded) {
    try {
      const storyBody: Record<string, unknown> = {
        media_type: "STORIES",
        access_token: accessToken,
      };
      if (mediaType === "VIDEO") storyBody.video_url = mediaUrls[0];
      else storyBody.image_url = mediaUrls[0];
      if (await checkBLLocationEligibility()) storyBody.location_id = instagramLocationId;

      const createResponse = await fetch(
        `https://graph.instagram.com/v22.0/${igUserId}/media`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(storyBody) }
      );
      const createData = await createResponse.json();
      if (createData.error) {
        const msg = createData.error.code === 100
          ? `Instagram Story rejected — account may be Personal (not Business/Creator). ${createData.error.message}`
          : createData.error.message;
        await insertIGRow("story", "failed", undefined, undefined, msg);
        subResults.push({ subtype: "story", status: "failed", error: msg });
      } else {
        await pollBusinessLoginContainerStatus(createData.id, accessToken, { deadlineMs: timing.deadlineMs });
        const publishData = await publishBusinessLoginMedia(igUserId, createData.id, accessToken);
        const fallbackUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
        const rowId = await insertIGRow("story", "success", publishData.id, fallbackUrl);
        subResults.push({ subtype: "story", status: "success", id: publishData.id, url: fallbackUrl });
        // Story permalinks usually unavailable; just skip enrichment but still try first-comment disable
        enrichInBackground(rowId, publishData.id, "story", fallbackUrl);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await insertIGRow("story", "failed", undefined, undefined, msg);
      subResults.push({ subtype: "story", status: "failed", error: msg });
    }
  }

  // ─── 2. REEL or FEED-VIDEO ─────────────────────────────────────────────────
  const wantReel = blPostTypes.includes("reel");
  const wantFeed = blPostTypes.includes("feed");
  const shareToFeed = resolveInstagramShareToFeed(metadata, wantFeed);

  // The feed post or reel is already live: recorded, not posted again (the story step above ran).
  // Already recorded on this post's own row, it is done: nothing to publish or write.
  const feedDone = retry.feedRecorded === true;
  if (live && !feedDone) {
    const subtype = mediaType === "VIDEO" && wantReel ? "reel" : "feed";
    const media = live.kind === "already_live" ? live.media : null;
    const note = live.kind === "already_live" ? ALREADY_LIVE_MESSAGE : alreadyLiveCopiesMessage(live.count);
    const url = media?.permalink ?? (username ? `https://www.instagram.com/${username}/` : `https://instagram.com`);
    const rowId = await insertIGRow(subtype, "success", media?.id, url, undefined, { warnings: [note] });
    // Not recorded: say so instead of reporting a success no row shows. A retry finds it live again.
    if (!rowId) throw new Error("This post is already live on Instagram, but it could not be recorded. Retrying is safe.");
    subResults.push({ subtype, status: "success", id: media?.id, url });
  }

  if (!live && !feedDone && mediaType === "VIDEO" && (wantReel || wantFeed)) {
    // Meta API: standalone feed videos must be posted as Reels.
    // If user picked "feed" alone, publish as Reel and warn.
    // Explicit UI/API share-to-feed controls visibility; type selection is only the legacy fallback.
    if (wantFeed && !wantReel) {
      warnings.push("Instagram feed-video posts are published as Reels (Meta API requirement).");
    }
    try {
      const reelsBody: Record<string, unknown> = {
        media_type: "REELS",
        video_url: mediaUrls[0],
        caption: post.caption,
        share_to_feed: shareToFeed,
        access_token: accessToken,
      };
      if (coverThumbnailOffset > 0) reelsBody.thumb_offset = coverThumbnailOffset;
      if (audioName) reelsBody.audio_name = audioName;
      if (collaborator) {
        const cleanCollaborator = collaborator.replace("@", "").trim();
        if (cleanCollaborator) reelsBody.collaborators = [cleanCollaborator];
      }
      if (await checkBLLocationEligibility()) reelsBody.location_id = instagramLocationId;

      // A resumed run already has the container; creating another would publish twice.
      let createData: Awaited<ReturnType<typeof blMediaCreateWithLocationRetry>> = timing.resume
        ? { id: timing.resume.deferral.container_id }
        : await blMediaCreateWithLocationRetry(
          `https://graph.instagram.com/v22.0/${igUserId}/media`,
          reelsBody,
        );

      if (createData.error && reelsBody.collaborators && (createData.error.code === 210 || createData.error.message?.includes("not visible"))) {
        const skipped = (reelsBody.collaborators as string[])[0];
        delete reelsBody.collaborators;
        warnings.push(`Collaborator @${skipped} skipped — must be a Business or Creator account.`);
        createData = await blMediaCreateWithLocationRetry(
          `https://graph.instagram.com/v22.0/${igUserId}/media`,
          reelsBody,
        );
      }

      if (createData.error) {
        let msg = createData.error.message;
        if (createData.error.code === 100) {
          msg = `Instagram rejected the request — account may be Personal (not Business/Creator) or app lacks instagram_content_publish. ${createData.error.message}`;
        } else if (createData.error.message?.includes("does not have permission")) {
          msg = `Instagram permission denied — please disconnect and reconnect Instagram on the Profiles page.`;
        }
        const subtype = wantReel ? "reel" : "feed";
        await insertIGRow(subtype, "failed", undefined, undefined, msg);
        subResults.push({ subtype, status: "failed", error: msg });
      } else {
        const containerId = graphId(createData, `Instagram ${wantReel ? "reel" : "feed"} container`);
        const reelStatus = await pollBusinessLoginContainerStatus(containerId, accessToken, {
          deferKind: "ig_business_reel",
          deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS),
        }, 30, 2000);
        const fallbackUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
        const subtype = wantReel ? "reel" : "feed";
        if (reelStatus === "PUBLISHED") {
          // Only a resumed run sees this: an earlier run's publish went unanswered, or its worker
          // stopped, after Instagram published. Find the media so its follow-up steps still run.
          const firstDeferredAt = Date.parse(timing.resume?.deferral.first_deferred_at ?? "");
          const media = await findPublishedMedia(
            `https://graph.instagram.com/v22.0/${igUserId}/media`,
            accessToken,
            post.caption,
            (Number.isFinite(firstDeferredAt) ? firstDeferredAt : Date.now()) - PUBLISHED_LOOKBACK_MS,
          );
          if (media) {
            const url = media.permalink ?? fallbackUrl;
            const rowId = await insertIGRow(subtype, "success", media.id, url, undefined, { shared_to_feed: shareToFeed });
            subResults.push({ subtype, status: "success", id: media.id, url });
            // A row that did not settle stays pending and is resumed: its follow-ups run then, once.
            if (rowId) enrichInBackground(rowId, media.id, subtype, url);
          } else {
            const note = "Instagram had already published this reel, but it could not be identified, so its first comment and comment setting were not applied.";
            await insertIGRow(subtype, "success", undefined, fallbackUrl, undefined, { warnings: [note] });
            subResults.push({ subtype, status: "success", url: fallbackUrl });
            warnings.push(note);
          }
        } else {
          const publishData = await publishBusinessLoginMedia(igUserId, containerId, accessToken, "ig_business_reel");
          const blDebug = await finalizeBLLocationDebug(publishData.id);
          const rowId = await insertIGRow(subtype, "success", publishData.id, fallbackUrl, undefined, {
            shared_to_feed: shareToFeed,
            ...(blDebug ? { location_debug: blDebug } : {}),
          });
          subResults.push({ subtype, status: "success", id: publishData.id, url: fallbackUrl });
          // A first run has no pending row to come back to, so it enriches whatever the record did.
          if (rowId || !timing.resume) enrichInBackground(rowId, publishData.id, subtype, fallbackUrl);
        }
      }
    } catch (e) {
      // Not a failure: the main loop records the container for the reconciler to finish.
      if (e instanceof ContainerStillProcessing) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      const subtype = wantReel ? "reel" : "feed";
      await insertIGRow(subtype, "failed", undefined, undefined, msg);
      subResults.push({ subtype, status: "failed", error: msg });
    }
  }

  // ─── 3. FEED IMAGE / CAROUSEL ──────────────────────────────────────────────
  if (!live && !feedDone && mediaType === "IMAGE" && wantFeed) {
    try {
      if (mediaUrls.length === 1) {
        const imageBody: Record<string, unknown> = {
          image_url: optimizedMediaUrls[0],
          caption: post.caption,
          access_token: accessToken,
        };
        if (collaborator) {
          const cleanCollaborator = collaborator.replace("@", "").trim();
          if (cleanCollaborator) imageBody.collaborators = [cleanCollaborator];
        }
        if (await checkBLLocationEligibility()) imageBody.location_id = instagramLocationId;
        if (igAltText) imageBody.alt_text = igAltText;

        let createData = await blMediaCreateWithLocationRetry(
          `https://graph.instagram.com/v22.0/${igUserId}/media`,
          imageBody,
        );

        if (createData.error && imageBody.collaborators && (createData.error.code === 210 || createData.error.message?.includes("not visible"))) {
          const skipped = (imageBody.collaborators as string[])[0];
          delete imageBody.collaborators;
          warnings.push(`Collaborator @${skipped} skipped.`);
          createData = await blMediaCreateWithLocationRetry(
            `https://graph.instagram.com/v22.0/${igUserId}/media`,
            imageBody,
          );
        }

        if (createData.error) {
          const msg = createData.error.message;
          await insertIGRow("feed", "failed", undefined, undefined, msg);
          subResults.push({ subtype: "feed", status: "failed", error: msg });
        } else {
          const containerId = graphId(createData, "Instagram feed container");
          await pollBusinessLoginContainerStatus(containerId, accessToken, { deadlineMs: timing.deadlineMs });
          const publishData = await publishBusinessLoginMedia(igUserId, containerId, accessToken);
          const fallbackUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
          const blDebug = await finalizeBLLocationDebug(publishData.id);
          const rowId = await insertIGRow("feed", "success", publishData.id, fallbackUrl, undefined, blDebug ? { location_debug: blDebug } : undefined);
          subResults.push({ subtype: "feed", status: "success", id: publishData.id, url: fallbackUrl });
          enrichInBackground(rowId, publishData.id, "feed", fallbackUrl);
        }
      } else {
        // Carousel
        // A resumed run already has the carousel container; creating another would publish twice.
        let carouselId: string;
        if (timing.resume) {
          carouselId = timing.resume.deferral.container_id;
        } else {
          const childEndpoint = `https://graph.instagram.com/v22.0/${igUserId}/media`;
          const containerIds = await createCarouselChildren(
            optimizedMediaUrls.slice(0, 10),
            (url) => ({ image_url: url, is_carousel_item: true, access_token: accessToken, ...(igAltText ? { alt_text: igAltText } : {}) }),
            async (childBody) => {
              // Bounded like every other Meta call: ten parallel creates cannot hang the worker.
              const response = await fetchWithTimeout(childEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(childBody) }, 20000);
              return await response.json();
            },
          );
          // The children share the carousel's deferrable budget so the publish still fits the worker.
          const children = await waitForCarouselChildren(
            "instagram",
            containerIds,
            (id) => `https://graph.instagram.com/v22.0/${id}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
            { deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS), maxAttempts: 30, intervalMs: 2000 },
          );
          // Instagram refuses a carousel missing a child, so one failed child fails the carousel.
          if (children.dropped.length > 0) throw new Error(containerFailureMessage("instagram", children.dropped[0].reason));

          const carouselBody: Record<string, unknown> = {
            media_type: "CAROUSEL",
            children: children.finished.join(","),
            caption: post.caption,
            access_token: accessToken,
          };
          if (collaborator) {
            const cleanCollaborator = collaborator.replace("@", "").trim();
            if (cleanCollaborator) carouselBody.collaborators = [cleanCollaborator];
          }
          if (await checkBLLocationEligibility()) carouselBody.location_id = instagramLocationId;

          let carouselData = await blMediaCreateWithLocationRetry(
            `https://graph.instagram.com/v22.0/${igUserId}/media`,
            carouselBody,
          );

          if (carouselData.error && carouselBody.collaborators && (carouselData.error.code === 210 || carouselData.error.message?.includes("not visible"))) {
            const skipped = (carouselBody.collaborators as string[])[0];
            delete carouselBody.collaborators;
            warnings.push(`Collaborator @${skipped} skipped.`);
            carouselData = await blMediaCreateWithLocationRetry(
              `https://graph.instagram.com/v22.0/${igUserId}/media`,
              carouselBody,
            );
          }

          if (carouselData.error) throw new Error(carouselData.error.message);
          carouselId = graphId(carouselData, "Instagram carousel container");
        }

        // The carousel can be finished later like a reel: the reconciler resumes a still-processing one.
        const carouselStatus = await pollBusinessLoginContainerStatus(carouselId, accessToken, {
          deferKind: "ig_carousel",
          deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS),
        }, 30, 2000);
        const fallbackUrl = `https://instagram.com`;
        if (carouselStatus === "PUBLISHED") {
          // Only a resumed run sees this: an earlier run's publish went unanswered, or its worker
          // stopped, after Instagram published. Find the media so its follow-up steps still run.
          const firstDeferredAt = Date.parse(timing.resume?.deferral.first_deferred_at ?? "");
          const media = await findPublishedMedia(
            `https://graph.instagram.com/v22.0/${igUserId}/media`,
            accessToken,
            post.caption,
            (Number.isFinite(firstDeferredAt) ? firstDeferredAt : Date.now()) - PUBLISHED_LOOKBACK_MS,
          );
          if (media) {
            const url = media.permalink ?? fallbackUrl;
            const rowId = await insertIGRow("feed", "success", media.id, url);
            subResults.push({ subtype: "feed", status: "success", id: media.id, url });
            // A row that did not settle stays pending and is resumed: its follow-ups run then, once.
            if (rowId) enrichInBackground(rowId, media.id, "feed", url);
          } else {
            const note = "Instagram had already published this carousel, but it could not be identified, so its first comment and comment setting were not applied.";
            await insertIGRow("feed", "success", undefined, fallbackUrl, undefined, { warnings: [note] });
            subResults.push({ subtype: "feed", status: "success", url: fallbackUrl });
            warnings.push(note);
          }
        } else {
          const publishData = await publishBusinessLoginMedia(igUserId, carouselId, accessToken, "ig_carousel");
          const blDebug = await finalizeBLLocationDebug(publishData.id);
          const rowId = await insertIGRow("feed", "success", publishData.id, fallbackUrl, undefined, blDebug ? { location_debug: blDebug } : undefined);
          subResults.push({ subtype: "feed", status: "success", id: publishData.id, url: fallbackUrl });
          // A first run has no pending row to come back to, so it enriches whatever the record did.
          if (rowId || !timing.resume) enrichInBackground(rowId, publishData.id, "feed", fallbackUrl);
        }
      }
    } catch (e) {
      // Not a failure: the main loop records the container for the reconciler to finish.
      if (e instanceof ContainerStillProcessing) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      await insertIGRow("feed", "failed", undefined, undefined, msg);
      subResults.push({ subtype: "feed", status: "failed", error: msg });
    }
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────
  // The feed post or reel an earlier run recorded still counts as this account's success, whatever
  // this retry's story did (its row already says so; nothing new is written).
  if (feedDone) subResults.push({ subtype: "feed", status: "success" });
  if (subResults.length === 0) {
    throw new Error("Instagram: no post type matched (selected: " + JSON.stringify(blPostTypes) + ")");
  }

  const anySuccess = subResults.find(r => r.status === "success");
  if (!anySuccess) {
    // All sub-posts failed — throw so the outer loop also marks the post failed,
    // but the rows are already in DB from insertIGRow above.
    const err = subResults.map(r => `${r.subtype}: ${r.error}`).join("; ");
    const error: Error & { selfWroteRows?: boolean } = new Error(err);
    error.selfWroteRows = true;
    throw error;
  }

  // attach warnings for the outer loop's logging only (they're already saved per-row)
  return {
    selfWroteRows: true,
    subResults,
    id: anySuccess.id,
    url: anySuccess.url,
    ...(warnings.length > 0 ? ({ warnings } as Record<string, unknown>) : {}),
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.4 LINKEDIN                                                            │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Post to LinkedIn (text posts, images, articles)
 */
async function postToLinkedIn(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[]
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;
  const personUrn = `urn:li:person:${account.platform_user_id}`;
  const metadata = post.metadata;
  const visibility = metadata?.linkedin_visibility || "public";
  const articleLink = metadata?.linkedin_article_link;

  // Build the list of destinations to publish to. Accept the new multi-select
  // field; fall back to legacy single linkedin_page_id; default to personal.
  const selectedDestinations = selectedLinkedInDestinationIds(
    metadata?.linkedin_destinations,
    account.id,
  );
  const rawDestinations = selectedDestinations.length > 0
    ? selectedDestinations
    : Array.isArray(metadata?.linkedin_destination_ids)
    ? (metadata!.linkedin_destination_ids as string[])
    : metadata?.linkedin_page_id
    ? ["personal", metadata.linkedin_page_id]
    : ["personal"];
  const destinationIds = Array.from(new Set(rawDestinations)).filter(Boolean);
  if (destinationIds.length === 0) destinationIds.push("personal");

  console.log(
    `LinkedIn post - destinations: ${destinationIds.join(",")}, visibility: ${visibility}, hasMedia: ${mediaUrls.length > 0}`
  );

  const resolveActorUrn = (id: string) =>
    id === "personal" ? personUrn : `urn:li:organization:${id}`;

  /**
   * Publish to a single LinkedIn actor (personal URN or organization URN).
   * Asset registration must happen per actor — LinkedIn rejects an asset
   * URN whose `owner` does not match the post `author`.
   */
  const publishToActor = async (actorUrn: string) => {
    const isOrg = actorUrn.startsWith("urn:li:organization:");

    const shareContent: Record<string, unknown> = {
      author: actorUrn,
      lifecycleState: "PUBLISHED",
      visibility: {
        // Organization pages cannot use CONNECTIONS visibility.
        "com.linkedin.ugc.MemberNetworkVisibility":
          !isOrg && visibility === "connections" ? "CONNECTIONS" : "PUBLIC",
      },
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: post.caption || "" },
          shareMediaCategory: "NONE",
        },
      },
    };

    if (articleLink) {
      (shareContent.specificContent as Record<string, unknown>)["com.linkedin.ugc.ShareContent"] = {
        shareCommentary: { text: post.caption || "" },
        shareMediaCategory: "ARTICLE",
        media: [{ status: "READY", originalUrl: articleLink }],
      };
    }

    if (mediaUrls.length > 0 && !articleLink) {
      const isImage = isImageUrl(mediaUrls[0]);
      if (isImage) {
        const registerResponse = await fetch(
          "https://api.linkedin.com/v2/assets?action=registerUpload",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              registerUploadRequest: {
                recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
                owner: actorUrn,
                serviceRelationships: [
                  { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
                ],
              },
            }),
          }
        );

        if (!registerResponse.ok) {
          const errorData = await registerResponse.json().catch(() => ({}));
          console.error("LinkedIn register error:", errorData);
          throw new Error(
            `LinkedIn image registration failed: ${errorData?.message || registerResponse.statusText}`
          );
        }

        const registerData = await registerResponse.json();
        const uploadUrl =
          registerData?.value?.uploadMechanism?.[
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
          ]?.uploadUrl;
        const asset = registerData?.value?.asset;
        if (!uploadUrl || !asset) throw new Error("LinkedIn did not return upload URL");

        const { blob, mimeType } = await downloadMediaAsBlob(mediaUrls[0]);
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": mimeType,
          },
          body: blob,
        });
        if (!uploadResponse.ok) {
          throw new Error(`LinkedIn image upload failed: ${uploadResponse.statusText}`);
        }

        (shareContent.specificContent as Record<string, unknown>)["com.linkedin.ugc.ShareContent"] = {
          shareCommentary: { text: post.caption || "" },
          shareMediaCategory: "IMAGE",
          media: [{ status: "READY", media: asset }],
        };
      }
    }

    const postResponse = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(shareContent),
    });

    if (!postResponse.ok) {
      const errorData = await postResponse.json().catch(() => ({}));
      console.error(`LinkedIn post error for ${actorUrn}:`, errorData);
      if (postResponse.status === 401) {
        throw new Error("LinkedIn authentication expired. Please reconnect your LinkedIn account.");
      }
      if (postResponse.status === 403) {
        throw new Error(
          `LinkedIn permission denied for ${actorUrn}. Make sure your app has w_member_social${isOrg ? " and w_organization_social" : ""} scope.`
        );
      }
      throw new Error(`LinkedIn API error: ${errorData?.message || postResponse.statusText}`);
    }

    const postData = await postResponse.json();
    const postId = postData.id as string;
    return { postId, url: `https://www.linkedin.com/feed/update/${postId}` };
  };

  // Fan out across selected destinations. Per-actor errors are captured;
  // overall result succeeds if at least one destination publishes.
  const results: Array<{
    destination_id: string;
    urn: string;
    post_id?: string;
    url?: string;
    status: "success" | "failed";
    error?: string;
  }> = [];

  for (const destId of destinationIds) {
    const urn = resolveActorUrn(destId);
    try {
      const r = await publishToActor(urn);
      results.push({ destination_id: destId, urn, post_id: r.postId, url: r.url, status: "success" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ destination_id: destId, urn, status: "failed", error: msg });
    }
  }

  const successes = results.filter((r) => r.status === "success");
  if (successes.length === 0) {
    const errors = results.map((r) => `${r.destination_id}: ${r.error}`).join("; ");
    throw new Error(`All LinkedIn destinations failed — ${errors}`);
  }

  const primary = successes[0];
  return {
    id: primary.post_id!,
    url: primary.url!,
    response_data: { destinations: results },
  } as PlatformPostResult;
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.5 PINTEREST                                                           │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Upload video to Pinterest and get media_id
 * Pinterest video upload is a 3-step process:
 * 1. Register media upload intent
 * 2. Upload video to S3
 * 3. Poll for processing completion
 */
async function uploadPinterestVideo(
  accessToken: string,
  videoUrl: string
): Promise<string> {
  console.log("Pinterest: Starting video upload process...");

  // Step 1: Register media upload intent
  const mediaIntentResponse = await fetch(
    "https://api.pinterest.com/v5/media",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        media_type: "video",
      }),
    }
  );

  const mediaIntentData = await mediaIntentResponse.json();
  console.log("Pinterest media intent response:", mediaIntentResponse.status, JSON.stringify(mediaIntentData).slice(0, 300));

  if (!mediaIntentResponse.ok || !mediaIntentData.media_id) {
    throw new Error(`Pinterest video intent failed: ${mediaIntentData.message || "Unknown error"}`);
  }

  const { media_id, upload_url, upload_parameters } = mediaIntentData;
  console.log(`Pinterest: Got media_id ${media_id}, uploading to S3...`);

  // Step 2: Download video and upload to Pinterest's S3
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to fetch video from URL: ${videoResponse.status}`);
  }

  const videoBuffer = await videoResponse.arrayBuffer();
  console.log(`Pinterest: Downloaded video, size: ${videoBuffer.byteLength} bytes`);

  // Build multipart form data with upload_parameters
  const formData = new FormData();

  // Add all upload parameters from Pinterest
  if (upload_parameters) {
    for (const [key, value] of Object.entries(upload_parameters)) {
      formData.append(key, String(value));
    }
  }

  // Add the file last (important for S3)
  const videoBlob = new Blob([videoBuffer], { type: "video/mp4" });
  formData.append("file", videoBlob, "video.mp4");

  const uploadResponse = await fetch(upload_url, {
    method: "POST",
    body: formData,
  });

  console.log("Pinterest S3 upload response:", uploadResponse.status);

  // S3 returns 204 No Content on success
  if (uploadResponse.status !== 204 && !uploadResponse.ok) {
    const uploadError = await uploadResponse.text();
    throw new Error(`Pinterest video upload to S3 failed: ${uploadResponse.status} - ${uploadError}`);
  }

  console.log("Pinterest: Video uploaded to S3, polling for processing...");

  // Step 3: Poll for video processing completion
  const maxAttempts = 60; // 5 minutes with 5-second intervals
  const pollInterval = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(
      `https://api.pinterest.com/v5/media/${media_id}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
        },
      }
    );

    const statusData = await statusResponse.json();
    console.log(`Pinterest: Video status check ${attempt + 1}/${maxAttempts}:`, statusData.status);

    if (statusData.status === "succeeded") {
      console.log("Pinterest: Video processing complete!");
      return media_id;
    }

    if (statusData.status === "failed") {
      throw new Error(`Pinterest video processing failed: ${statusData.failure_code || "Unknown error"}`);
    }

    // Continue polling for "registered" or "processing" status
  }

  throw new Error("Pinterest video processing timed out after 5 minutes");
}

/**
 * Post to Pinterest (creates pins for images or videos)
 */
async function postToPinterest(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  supabase: SupabaseClient,
  processingStartedAt?: string | null,
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;

  if (mediaUrls.length === 0) {
    throw new Error("Pinterest requires at least one image or video");
  }

  // Get Pinterest settings from metadata
  const metadata = post.metadata;

  // Nested Pinterest metadata (used by our API): metadata.pinterest.{ boardId, title, link }
  const pinterestMetaUnknown = (metadata as unknown as { pinterest?: unknown } | null | undefined)?.pinterest;
  const pinterestMeta =
    pinterestMetaUnknown && typeof pinterestMetaUnknown === "object"
      ? (pinterestMetaUnknown as Record<string, unknown>)
      : undefined;
  const nestedBoardId =
    typeof pinterestMeta?.boardId === "string"
      ? (pinterestMeta.boardId as string)
      : typeof pinterestMeta?.board_id === "string"
        ? (pinterestMeta.board_id as string)
        : undefined;
  const nestedTitle = typeof pinterestMeta?.title === "string" ? (pinterestMeta.title as string) : undefined;
  const nestedLink = typeof pinterestMeta?.link === "string" ? (pinterestMeta.link as string) : undefined;

  // Check if a board ID was specified in the post metadata
  // Support both legacy flat metadata keys and nested metadata.pinterest.* (used by our API)
  const specifiedBoardId = nestedBoardId ?? metadata?.pinterest_board_id;

  // Fetch user's boards to validate the board ID or get the first one
  const boardsResponse = await fetch(
    "https://api.pinterest.com/v5/boards",
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
    }
  );

  const boardsData = await boardsResponse.json();
  console.log("Pinterest boards response:", boardsResponse.status);

  if (!boardsResponse.ok || !boardsData.items || boardsData.items.length === 0) {
    throw new Error("No Pinterest boards found. Please create a board first.");
  }

  // Get list of valid board IDs
  const validBoardIds = boardsData.items.map((b: { id: string }) => b.id);
  console.log(`Pinterest: Available boards: ${validBoardIds.join(", ")}`);

  let boardId: string;

  // Validate the specified board ID exists in user's boards
  if (specifiedBoardId && validBoardIds.includes(specifiedBoardId)) {
    boardId = specifiedBoardId;
    console.log(`Using selected Pinterest board: ${boardId}`);
  } else {
    // Fallback: use first available board
    if (specifiedBoardId) {
      console.log(`Pinterest: Specified board ID "${specifiedBoardId}" not found in user's boards. Using first available board instead.`);
    }
    boardId = boardsData.items[0].id;
    console.log(`Using first available Pinterest board: ${boardId}`);
  }

  // Check if first media is a video
  const firstMediaUrl = mediaUrls[0];
  const isVideo = isVideoUrl(firstMediaUrl);

  console.log(`Pinterest: Media type detected: ${isVideo ? "video" : "image"}`);

  // Resolve the post type for History UI ("video" | "image" | "link" | "multi")
  const hasLink = !!(nestedLink || metadata?.pinterest_link);
  const resolvedPinType: "video" | "image" | "link" | "multi" =
    isVideo ? "video"
    : mediaUrls.length > 1 ? "multi"
    : hasLink ? "link"
    : "image";

  // Stamp pinterest_post_type onto the post's metadata using narrow atomic RPC so /history can render badge
  const stampPinterestType = async () => {
    if (!processingStartedAt) {
      console.warn("Pinterest: processingStartedAt missing, skipping stamp_pinterest_post_type");
      return;
    }
    try {
      const { data, error } = await supabase.rpc("stamp_pinterest_post_type", {
        p_post_id: post.id,
        p_social_account_id: account.id,
        p_expected_processing_started_at: processingStartedAt,
        p_expected_content: threadsImageContentFence(post),
        p_post_type: resolvedPinType,
      });
      if (error) {
        console.warn("Pinterest: stamp_pinterest_post_type RPC error:", error);
      } else if (!data) {
        console.warn("Pinterest: stamp_pinterest_post_type returned false (fence mismatch or post state mismatch)");
      }
    } catch (err) {
      console.warn("Pinterest: failed to stamp pinterest_post_type:", err);
    }
  };

  // Pinterest API doesn't support carousel pins via standard API
  // For videos, only one video pin is supported
  const createdPins: { id: string; url: string }[] = [];
  const errors: string[] = [];

  // If video, handle video upload flow
  if (isVideo) {
    console.log("Pinterest: Processing video pin...");

    try {
      // Upload video and get media_id
      const mediaId = await uploadPinterestVideo(accessToken, firstMediaUrl);

      // Build pin request body for video
      // Pinterest requires a cover image - use key_frame_time to auto-extract from video
      const pinBody: Record<string, unknown> = {
        board_id: boardId,
        media_source: {
          source_type: "video_id",
          media_id: mediaId,
          cover_image_key_frame_time: 1.0, // Use frame at 1 second as cover image
        },
      };

      // Use custom title or fall back to caption
      let baseTitle =
        nestedTitle ||
        metadata?.pinterest_title ||
        post.caption ||
        "New Video Pin";
      if (baseTitle.length > 100) {
        baseTitle = baseTitle.substring(0, 97).trim() + "...";
      }
      pinBody.title = baseTitle;

      // Use caption as description
      pinBody.description = post.caption?.substring(0, 500) || "";

      // Add destination link if provided
      const destinationLink = nestedLink || metadata?.pinterest_link;
      if (destinationLink) {
        pinBody.link = destinationLink;
      }

      console.log("Pinterest video pin request:", JSON.stringify(pinBody).slice(0, 300));

      // Create the video pin
      const pinResponse = await fetch(
        "https://api.pinterest.com/v5/pins",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(pinBody),
        }
      );

      const pinData = await pinResponse.json();
      console.log("Pinterest create video pin response:", pinResponse.status, JSON.stringify(pinData).slice(0, 200));

      if (!pinResponse.ok || pinData.code) {
        const errorCode = pinData.code || pinResponse.status;
        const errorMessage = pinData.message || "";

        if (errorCode === 403 || errorCode === "403" || errorMessage.toLowerCase().includes("permission") || errorMessage.toLowerCase().includes("scope")) {
          throw new Error("Pinterest permission denied: Your app needs 'pins:write' scope. Please upgrade to Standard Access in the Pinterest Developer Console.");
        }

        if (errorCode === 401 || errorCode === "401" || errorMessage.toLowerCase().includes("unauthorized")) {
          throw new Error("Pinterest authentication failed: Please reconnect your Pinterest account.");
        }

        throw new Error(pinData.message || `Pinterest API error: ${pinData.code}`);
      }

      await stampPinterestType();
      return {
        id: pinData.id,
        url: `https://pinterest.com/pin/${pinData.id}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Pinterest video pin failed:", errorMsg);
      throw new Error(`Pinterest video pin failed: ${errorMsg}`);
    }
  }

  // Handle image pins
  console.log(`Pinterest: Creating ${mediaUrls.length} separate pin(s) for ${mediaUrls.length} image(s)`);

  for (let i = 0; i < mediaUrls.length; i++) {
    const imageUrl = mediaUrls[i];

    // Build pin request body with all settings
    const pinBody: Record<string, unknown> = {
      board_id: boardId,
      media_source: {
        source_type: "image_url",
        url: imageUrl,
      },
    };

    // Use custom title or fall back to caption
    const suffix = mediaUrls.length > 1 ? ` (${i + 1}/${mediaUrls.length})` : "";
    const maxTitleLength = 100 - suffix.length;

    let baseTitle = metadata?.pinterest_title || post.caption || "New Pin";
    if (baseTitle.length > maxTitleLength) {
      baseTitle = baseTitle.substring(0, maxTitleLength - 3).trim() + "...";
    }
    pinBody.title = baseTitle + suffix;

    // Use caption as description
    pinBody.description = post.caption?.substring(0, 500) || "";

    // Add destination link if provided
    if (metadata?.pinterest_link) {
      pinBody.link = metadata.pinterest_link;
    }

    // Add alt text if provided
    if (metadata?.pinterest_alt_text) {
      pinBody.alt_text = metadata.pinterest_alt_text;
    }

    // Add note if provided (private note)
    if (metadata?.pinterest_note) {
      pinBody.note = metadata.pinterest_note;
    }

    console.log(`Pinterest pin ${i + 1}/${mediaUrls.length} request:`, JSON.stringify(pinBody).slice(0, 300));

    try {
      // Create a pin
      const pinResponse = await fetch(
        "https://api.pinterest.com/v5/pins",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(pinBody),
        }
      );

      const pinData = await pinResponse.json();
      console.log(`Pinterest create pin ${i + 1} response:`, pinResponse.status, JSON.stringify(pinData).slice(0, 200));

      if (!pinResponse.ok || pinData.code) {
        const errorCode = pinData.code || pinResponse.status;
        const errorMessage = pinData.message || "";

        if (errorCode === 403 || errorCode === "403" || errorMessage.toLowerCase().includes("permission") || errorMessage.toLowerCase().includes("scope")) {
          throw new Error("Pinterest permission denied: Your app needs 'pins:write' scope. Please upgrade to Standard Access in the Pinterest Developer Console.");
        }

        if (errorCode === 401 || errorCode === "401" || errorMessage.toLowerCase().includes("unauthorized")) {
          throw new Error("Pinterest authentication failed: Please reconnect your Pinterest account.");
        }

        throw new Error(pinData.message || `Pinterest API error: ${pinData.code}`);
      }

      createdPins.push({
        id: pinData.id,
        url: `https://pinterest.com/pin/${pinData.id}`
      });

      // Add a small delay between pin creations to avoid rate limiting
      if (i < mediaUrls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Pin ${i + 1}: ${errorMsg}`);
      console.error(`Pinterest pin ${i + 1} failed:`, errorMsg);

      // If first pin fails with auth/permission error, throw immediately
      if (i === 0 && (errorMsg.includes("permission") || errorMsg.includes("authentication"))) {
        throw error;
      }
    }
  }

  // If all pins failed, throw an error
  if (createdPins.length === 0) {
    throw new Error(`All Pinterest pins failed: ${errors.join("; ")}`);
  }

  // If some pins failed, log a warning but return success for the ones that worked
  if (errors.length > 0) {
    console.warn(`Pinterest: ${createdPins.length}/${mediaUrls.length} pins created. Errors: ${errors.join("; ")}`);
  }

  // Return the first pin's info (primary), but include all pin IDs in the response
  await stampPinterestType();
  return {
    id: createdPins.map(p => p.id).join(","),
    url: createdPins.length === 1
      ? createdPins[0].url
      : `https://pinterest.com/pin/${createdPins[0].id}`
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.6 REDDIT                                                              │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Post to Reddit (self posts, link posts, image posts)
 */
async function postToReddit(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[]
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;
  const username = account.platform_username;
  const metadata = post.metadata;

  console.log(`Reddit: Starting post for user u/${username}...`);

  // Reddit requires a subreddit
  const subreddit = metadata?.reddit_subreddit;
  if (!subreddit) {
    throw new Error("Reddit requires a subreddit to be specified");
  }

  // Reddit requires a title
  const title = metadata?.reddit_title || post.caption?.substring(0, 300) || "Untitled";
  if (!title) {
    throw new Error("Reddit requires a title");
  }

  const postType = metadata?.reddit_post_type || "self";
  const apiParams: Record<string, string> = {
    api_type: "json",
    sr: subreddit,
    title: title,
    resubmit: "true",
    sendreplies: String(metadata?.reddit_send_replies !== false),
  };

  if (metadata?.reddit_spoiler) {
    apiParams.spoiler = "true";
  }
  if (metadata?.reddit_nsfw) {
    apiParams.nsfw = "true";
  }
  if (metadata?.reddit_flair) {
    apiParams.flair_text = metadata.reddit_flair;
  }

  // Determine post type
  if (postType === "link" && metadata?.reddit_link_url) {
    apiParams.kind = "link";
    apiParams.url = metadata.reddit_link_url;
  } else if (postType === "image" && mediaUrls.length > 0) {
    apiParams.kind = "link";
    apiParams.url = mediaUrls[0]; // Direct image URL
  } else {
    // Self post (text)
    apiParams.kind = "self";
    apiParams.text = post.caption || "";
  }

  console.log(`Reddit: Creating ${apiParams.kind} post in r/${subreddit}...`);

  const response = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Postora/1.0",
    },
    body: new URLSearchParams(apiParams),
  });

  const data = await response.json();

  console.log("Reddit: Submit response:", JSON.stringify(data).slice(0, 300));

  if (data.json?.errors && data.json.errors.length > 0) {
    const errorMessages = data.json.errors.map((e: string[]) => e.join(": ")).join("; ");
    throw new Error(`Reddit API error: ${errorMessages}`);
  }

  if (!data.json?.data?.url) {
    throw new Error("Reddit API did not return a post URL");
  }

  const postUrl = data.json.data.url;
  const postId = data.json.data.name || data.json.data.id;

  console.log(`Reddit: Post created successfully! URL: ${postUrl}`);

  return {
    id: postId,
    url: postUrl,
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.7 THREADS                                                             │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Post to Threads (Meta's Twitter alternative)
 */
async function postToThreads(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  timing: PublishTiming = NO_DEFERRAL,
  imageCheckpoint?: ThreadsImageCheckpoint,
  attemptStartedAt?: string | null,
): Promise<PlatformPostResult> {
  if (timing.resume?.deferral.media_type === "IMAGE" && timing.resume.accountUpdatedAt &&
    (account as SocialAccount & { updated_at?: string | null }).updated_at !== timing.resume.accountUpdatedAt) {
    throw new ThreadsCheckpointUnavailable("Threads image account credentials changed; pending state retained");
  }
  const accessToken = account.access_token;
  const userId = account.platform_user_id;
  const username = account.platform_username;
  const metadata = post.metadata;

  console.log(`Threads: Starting post for user ${username}...`);

  // Threads API uses a two-step process: create container, then publish
  const containerEndpoint = `https://graph.threads.net/v1.0/${userId}/threads`;
  const publishEndpoint = `https://graph.threads.net/v1.0/${userId}/threads_publish`;

  // Truncate caption for Threads (500 char limit)
  const THREADS_CHAR_LIMIT = 500;
  const threadsWarnings: string[] = [];

  // ── Location Debug Mode (Threads) ──────────────────────────────────────
  const LOCATION_DEBUG_MODE =
    Deno.env.get("LOCATION_DEBUG_MODE") === "true" ||
    (metadata as Record<string, unknown> | undefined)?.location_debug === true ||
    !!(metadata?.threads_location_id ||
      (metadata as Record<string, unknown> | undefined)?.threads_location_skipped_reason ||
      metadata?.instagram_location_id);
  const tLocationDebug: Record<string, unknown> = {
    platform: "threads",
    selected_location_id: metadata?.threads_location_id ?? null,
    selected_location_object: (metadata as Record<string, unknown> | undefined)?.threads_location_object ?? null,
    skipped_reason: (metadata as Record<string, unknown> | undefined)?.threads_location_skipped_reason ?? null,
    capability_can_use_location_tagging: null as boolean | null,
    native_ok: false,
    container_endpoint: "/v1.0/{threads_user_id}/threads",
    container_params_had_location_id: false,
    container_location_id_sent: null as string | null,
    create_container_success: null as boolean | null,
    create_container_error: null as ReturnType<typeof redactMetaError>,
    publish_success: null as boolean | null,
    publish_error: null as ReturnType<typeof redactMetaError>,
    post_publish_verify_attempted: false,
    post_publish_verify_result: null as string | null,
    post_publish_verify_error: null as string | null,
    post_publish_location_field: null as unknown,
    final_reason_location_not_visible: null as string | null,
  };

  // ── Topic Tag debug (Threads-only, sent as `topic_tag` to Meta) ────────
  const rawTopicTagInput = (
    (metadata as Record<string, unknown> | undefined)?.threads_topic_tag as
      | string
      | null
      | undefined
  )?.toString().trim() || "";
  let cleanedTopicTag: string | null = null;
  if (rawTopicTagInput) {
    const cleaned = rawTopicTagInput.replace(/[.&]/g, "").slice(0, 50).trim();
    if (cleaned.length >= 1) cleanedTopicTag = cleaned;
  }
  const tTopicTagDebug: Record<string, unknown> = {
    raw: rawTopicTagInput || null,
    cleaned: cleanedTopicTag,
    sent: false,
    accepted: false,
    returned_by_meta: null as string | null,
  };
  let threadsText = post.caption || "";
  if (threadsText.length > THREADS_CHAR_LIMIT) {
    const originalLength = threadsText.length;
    const truncated = threadsText.substring(0, THREADS_CHAR_LIMIT - 1);
    const lastSpace = truncated.lastIndexOf(" ");
    threadsText = (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + "…";
    console.log(`Threads: Caption truncated from ${originalLength} to ${threadsText.length} chars`);
    threadsWarnings.push(`Caption exceeded Threads' 500 character limit (${originalLength} chars) and was auto-truncated.`);
  }

  // Build container params
  const containerParams: Record<string, string> = {
    access_token: accessToken,
    text: threadsText,
  };

  // Add reply control if specified
  if (metadata?.threads_reply_control && metadata.threads_reply_control !== "everyone") {
    const replyControlMap: Record<string, string> = {
      followers: "followers_only",
      following: "accounts_you_follow",
      mentioned: "mentioned_only",
    };
    const mapped = replyControlMap[metadata.threads_reply_control];
    if (mapped) containerParams.reply_control = mapped;
  }

  // ── Topic tag ───────────────────────────────────────────────────────────
  // Meta Threads API: optional `topic_tag` (1–50 chars, no "." or "&").
  // We sanitize again server-side, then attach. Never fail the whole post.
  if (cleanedTopicTag) {
    containerParams.topic_tag = cleanedTopicTag;
    tTopicTagDebug.sent = true;
    console.log(`Threads: Adding topic_tag="${cleanedTopicTag}" (raw="${rawTopicTagInput}")`);
  } else if (rawTopicTagInput) {
    threadsWarnings.push(
      "Topic tag was empty after removing disallowed characters and was not sent."
    );
  }

  // Read capability flags from account metadata (written by threads-oauth probe)
  const caps = (account.account_metadata as any)?.capabilities || {};
  let canCrossShareToIg: boolean | null =
    typeof caps.canCrossShareToIg === "boolean" ? caps.canCrossShareToIg : null;
  // Fallback: if capability is still null, check the granted_scopes array directly
  if (canCrossShareToIg === null) {
    const grantedScopes: string[] = (account.account_metadata as any)?.granted_scopes || [];
    if (grantedScopes.includes("threads_share_to_instagram")) {
      canCrossShareToIg = true;
      console.log("Threads: canCrossShareToIg resolved to true via granted_scopes fallback");
    }
  }
  const canUseLocationTagging: boolean | null =
    typeof caps.canUseLocationTagging === "boolean" ? caps.canUseLocationTagging : null;
  tLocationDebug.capability_can_use_location_tagging = canUseLocationTagging;

  // Determine media composition for cross-share guard
  const hasAnyVideo = mediaUrls.some((u) => isVideoUrl(u));
  const isPureTextOrImage = !hasAnyVideo; // text-only or image(s)

  // ── Location tagging pre-flight guard ─────────────────────────────────
  const rawLocId: string | undefined = metadata?.threads_location_id || undefined;
  const preSkippedReason = metadata?.threads_location_skipped_reason;
  if (rawLocId && rawLocId.startsWith("osm_")) {
    threadsWarnings.push(
      "Location skipped — selected place was a reference (OpenStreetMap), not a Threads-tagable location."
    );
    console.log(`Threads: Skipping location: osm_reference (${rawLocId})`);
    logLocationEvent({
      userId: post.user_id,
      errorCode: "threads_location_skipped",
      level: "info",
      message: "Threads location skipped — OSM reference",
      details: {
        platform: "threads",
        social_account_id: account.id,
        post_id: post.id,
        location_id: rawLocId,
        reason: "osm_reference",
      },
    });
  } else if (preSkippedReason === "osm_reference") {
    threadsWarnings.push(
      "Location skipped — selected place was a reference (OpenStreetMap), not a Threads-tagable location."
    );
    console.log("Threads: Skipping location: osm_reference (pre-stripped by client)");
    logLocationEvent({
      userId: post.user_id,
      errorCode: "threads_location_skipped",
      level: "info",
      message: "Threads location skipped — OSM reference (pre-stripped)",
      details: {
        platform: "threads",
        social_account_id: account.id,
        post_id: post.id,
        reason: "osm_reference_pre_stripped",
      },
    });
  } else if (preSkippedReason === "non_native_source" || preSkippedReason === "not_taggable" || preSkippedReason === "unverified_source") {
    threadsWarnings.push(
      "Threads location skipped — only native Threads location results can be tagged. Reference / Facebook places aren't accepted by Threads."
    );
    console.log(`Threads: Skipping location: ${preSkippedReason} (${rawLocId})`);
    logLocationEvent({
      userId: post.user_id,
      errorCode: "threads_location_skipped",
      level: "info",
      message: `Threads location skipped — ${preSkippedReason}`,
      details: {
        platform: "threads",
        social_account_id: account.id,
        post_id: post.id,
        location_id: rawLocId || null,
        reason: preSkippedReason,
      },
    });
  } else if (rawLocId) {
    // Only attach when metadata explicitly confirms a native Threads-source object.
    const obj: any = (metadata as any)?.threads_location_object;
    const isNativeTaggable = obj && obj.id === rawLocId && obj.source === "threads" && obj.taggable_on_threads === true;
    if (isNativeTaggable) {
      containerParams.location_id = rawLocId;
      tLocationDebug.native_ok = true;
      tLocationDebug.container_params_had_location_id = true;
      tLocationDebug.container_location_id_sent = rawLocId;
      console.log(`Threads: Adding native location_id: ${rawLocId} (canUseLocationTagging=${canUseLocationTagging})`);
    } else {
      threadsWarnings.push(
        "Threads location skipped — only native Threads location results can be tagged. The selected place could not be verified as a native Threads location."
      );
      console.log(`Threads: Skipping location: unverified (${rawLocId})`);
      logLocationEvent({
        userId: post.user_id,
        errorCode: "threads_location_skipped",
        level: "info",
        message: "Threads location skipped — unverified source",
        details: {
          platform: "threads",
          social_account_id: account.id,
          post_id: post.id,
          location_id: rawLocId,
          location_source: obj?.source || null,
          reason: "unverified_source_runtime",
        },
      });
    }
  }

  // ── Cross-share to Instagram Story pre-flight guard ───────────────────
  // Meta's `crossreshare_to_ig` requires renderable media (Stories cannot be
  // text-only). Sending it on a TEXT thread or with no media triggers
  // Graph error code=33 ("This object does not exist or does not support
  // this action"). Videos are also currently blocked by our integration.
  const wantsCrossShare = !!metadata?.threads_cross_share_to_ig;
  let crossShareApplied = false;
  let crossShareCapabilityAtPublish: boolean | null = null;
  let crossShareIgStatus: string | undefined;
  if (wantsCrossShare) {
    crossShareCapabilityAtPublish = canCrossShareToIg;
    if (canCrossShareToIg === false) {
      threadsWarnings.push(
        "Skipped Share to Instagram — token doesn't include threads_share_to_instagram. Reconnect Threads."
      );
      console.log("Threads: Skipping cross-share — capability=false (stale token)");
    } else if (mediaUrls.length === 0) {
      threadsWarnings.push(
        "Share to Instagram requires an image. Text-only Threads posts cannot be cross-shared to an Instagram Story."
      );
      console.log("Threads: Skipping cross-share — text-only post (no media)");
    } else if (hasAnyVideo) {
      threadsWarnings.push(
        "Share to Instagram only supports image posts. Your video was published to Threads only."
      );
      console.log("Threads: Skipping cross-share — video media unsupported");
    } else {
      // Meta's Threads Graph API parameter is `crossreshare_to_ig` (their spelling).
      // The previous name `crosspost_to_instagram` was silently ignored — Thread
      // published, IG Story never created. See docs:
      // https://developers.facebook.com/docs/threads/reference/publishing/
      containerParams.crossreshare_to_ig = "true";
      crossShareApplied = true;
      console.log("Threads: Enabling cross-share to Instagram Story (crossreshare_to_ig=true)");
      if (metadata?.threads_cross_share_to_ig_dark_mode) {
        containerParams.crossreshare_to_ig_dark_mode = "true";
        console.log("Threads: Enabling dark mode for cross-share");
      }
      if (canCrossShareToIg === null) {
        threadsWarnings.push(
          "Cross-sharing to Instagram Story was requested. The threads_share_to_instagram scope could not be verified — if the story doesn't appear, reconnect Threads and ensure your Instagram account is linked in Meta Accounts Center."
        );
      }
    }
  }


  // ── Verbose redacted debug log ────────────────────────────────────────
  const tokenPrefix = (accessToken || "").slice(0, 6);
  const tokenLen = (accessToken || "").length;
  const redactedParams = { ...containerParams, access_token: `[redacted:${tokenLen}c:${tokenPrefix}…]` };
  console.log(
    `Threads: Pre-publish state user=${username} token_len=${tokenLen} prefix=${tokenPrefix}… ` +
    `caps={crossShare:${canCrossShareToIg},location:${canUseLocationTagging}} ` +
    `endpoint=${containerEndpoint} payload=${JSON.stringify(redactedParams).slice(0, 600)}`
  );

  // Handle media
  if (mediaUrls.length > 0 || timing.resume) {
    // Threads has an 8MB per-image hard limit and rejects the whole carousel
    // (error 4279004 "Invalid carousel children") if any single child exceeds
    // it. Cloudinary URLs can be compressed on-the-fly to JPEG q_80 which
    // typically reduces PNGs by ~95% with no visible quality loss.
    const safeMediaUrls = compressMediaUrlsForPlatform(mediaUrls);
    const firstMediaUrl = safeMediaUrls[0];
    const isVideo = firstMediaUrl ? isVideoUrl(firstMediaUrl) : false;

    if (timing.resume && !timing.resume.deferral.carousel_children) {
      containerParams.media_type = timing.resume.deferral.kind === "threads_carousel" ? "CAROUSEL" : threadsMediaType(timing.resume.deferral);
    } else if (mediaUrls.length === 1 && !timing.resume?.deferral.carousel_children) {
      // Single media
      if (isVideo) {
        containerParams.media_type = "VIDEO";
        containerParams.video_url = firstMediaUrl;
      } else {
        containerParams.media_type = "IMAGE";
        containerParams.image_url = firstMediaUrl;
      }
    } else {
      // Carousel - create child containers first
      containerParams.media_type = "CAROUSEL";
      const childIds: string[] = [...(timing.resume?.deferral.carousel_children ?? [])];

      const childReplies = childIds.length ? [] : await Promise.all(safeMediaUrls.slice(0, 10).map(async (mediaUrl) => {
        const isChildVideo = isVideoUrl(mediaUrl);
        const childParams: Record<string, string> = {
          access_token: accessToken,
          is_carousel_item: "true",
        };

        if (isChildVideo) {
          childParams.media_type = "VIDEO";
          childParams.video_url = mediaUrl;
        } else {
          childParams.media_type = "IMAGE";
          childParams.image_url = mediaUrl;
        }

        const childUrl = new URL(containerEndpoint);
        Object.entries(childParams).forEach(([key, value]) => {
          childUrl.searchParams.set(key, value);
        });

        const childResponse = await fetchWithTimeout(childUrl.toString(), { method: "POST" }, 20000);
        const childData = await childResponse.json();

        if (childData.error) {
          console.error(
            "Threads: Child container error:",
            childData.error.message,
            "| media_url:",
            mediaUrl.slice(0, 100),
            "| error_subcode:",
            childData.error.error_subcode
          );
          return null;
        }
        if (!childData.id) throw new Error("Threads returned no child container id");
        return String(childData.id);
      }));
      childIds.push(...childReplies.filter((id): id is string => id !== null));

      // Meta refuses a carousel whose children are still processing: every child is waited for.
      const children = await waitForCarouselChildren(
        "threads",
        childIds,
        (id) => `https://graph.threads.net/v1.0/${id}?fields=${CONTAINER_STATUS_FIELDS.threads}&access_token=${accessToken}`,
        threadsChildWait(timing.deadlineMs, WORKER_STARTED_AT_MS),
      );
      for (const dropped of children.dropped) {
        console.error("Threads: Child container failed:", dropped.reason, "| id:", dropped.id);
      }
      childIds.splice(0, childIds.length, ...children.finished);

      // If no children were created successfully, fail fast with a clear
      // error instead of letting Threads return the generic "Invalid
      // parameter" message.
      if (childIds.length === 0) {
        throw new Error(
          "Threads rejected all carousel child containers. This usually means " +
          "every image exceeded Threads' 8MB per-image limit or used an " +
          "unsupported format. Original media URLs: " +
          safeMediaUrls.slice(0, 3).map((u) => u.slice(0, 80)).join(", ")
        );
      }

      // If some children failed but not all, warn but proceed — Threads
      // will still publish a partial carousel.
      if (childIds.length < safeMediaUrls.length) {
        console.warn(
          `Threads: ${safeMediaUrls.length - childIds.length} carousel child(ren) ` +
          `failed; publishing partial carousel with ${childIds.length} item(s).`
        );
        threadsWarnings.push(
          `${safeMediaUrls.length - childIds.length} of ${safeMediaUrls.length} ` +
          `carousel images were rejected by Threads (likely over 8MB or unsupported ` +
          `format). Published with ${childIds.length} image(s) instead.`
        );
      }

      containerParams.children = childIds.join(",");
    }
  } else {
    containerParams.media_type = "TEXT";
  }

  // Creating the container is skipped on a resumed run, which already has one.
  const createThreadsContainer = async (): Promise<string> => {
    console.log("Threads: Creating container...");

    // Create the container
    const containerUrl = new URL(containerEndpoint);
    Object.entries(containerParams).forEach(([key, value]) => {
      containerUrl.searchParams.set(key, value);
    });

    const containerResponse = await fetchWithTimeout(containerUrl.toString(), { method: "POST" }, 20000);
    const containerData = await containerResponse.json();

    console.log("Threads: Container response:", JSON.stringify(containerData).slice(0, 200));

    if (containerData.error) {
      tLocationDebug.create_container_success = false;
      tLocationDebug.create_container_error = redactMetaError(containerData.error);
      const errMsg = (containerData.error.message || "").toString();
      const errCode = containerData.error.code;
      const errLower = errMsg.toLowerCase();
      const wantedCrossShare = !!metadata?.threads_cross_share_to_ig;

      // If we sent crossreshare_to_ig and Meta rejected the container, retry
      // ONCE without the cross-share flag so the Thread itself still publishes.
      // Common cases:
      //  - code 33 ("does not exist or does not support this action") → no IG
      //    account linked in Meta Accounts Center, or media not Story-eligible.
      //  - code 10 / 200                                              → missing
      //    threads_share_to_instagram scope on the token.
      const crossShareLikelyCulprit =
        crossShareApplied && (
          errCode === 33 || errCode === 10 || errCode === 200 ||
          errLower.includes("crossreshare") ||
          errLower.includes("crosspost") ||
          errLower.includes("instagram") ||
          errLower.includes("ig account") ||
          errLower.includes("linked")
        );

      if (crossShareLikelyCulprit) {
        console.warn(
          `Threads: Container create failed with cross-share enabled [code=${errCode}]: ${errMsg}. Retrying without crossreshare_to_ig…`
        );
        delete containerParams.crossreshare_to_ig;
        delete containerParams.crossreshare_to_ig_dark_mode;
        crossShareApplied = false;
        crossShareIgStatus = "rejected_by_meta";
        threadsWarnings.push(
          `Instagram Story cross-share was rejected by Meta (code ${errCode}). Make sure your Instagram account is linked to this Threads profile in Meta Accounts Center, then reconnect Threads in Postora. The Thread itself was still published.`
        );

        const retryUrl = new URL(containerEndpoint);
        Object.entries(containerParams).forEach(([key, value]) => {
          retryUrl.searchParams.set(key, value);
        });
        const retryResponse = await fetchWithTimeout(retryUrl.toString(), { method: "POST" }, 20000);
        const retryData = await retryResponse.json();
        console.log("Threads: Retry container response:", JSON.stringify(retryData).slice(0, 200));
        if (retryData.error) {
          throw new Error(`Threads API error [code=${retryData.error.code}]: ${retryData.error.message}`);
        }
        // Replace containerData with the successful retry so downstream code uses it.
        (containerData as Record<string, unknown>).id = retryData.id;
      } else {
        throw new Error(`Threads API error [code=${errCode}]: ${containerData.error.message}`);
      }
    }

    tLocationDebug.create_container_success = true;
    // If we sent a topic_tag and the container creation succeeded, Meta accepted it.
    if (tTopicTagDebug.sent) {
      tTopicTagDebug.accepted = true;
    }
    return containerData.id;
  };

  // A resumed run already has the container; creating another would post twice.
  const containerId = await threadsParentContainer(timing.resume, createThreadsContainer);

  // A new image is durable before any status traffic. A successful exclusive claim
  // permits one finite inline observation; a refusal leaves ordinary cron recovery.
  if (!timing.resume && containerParams.media_type === "IMAGE") {
    if (typeof containerId !== "string" || !containerId || !attemptStartedAt) {
      throw new ThreadsCheckpointUnavailable("Threads image container identity or claim fence is missing");
    }
    const deferral = newDeferral("threads", containerId, new Date(), { mediaType: "IMAGE", attemptStartedAt });
    const checkpoint = await checkpointThreadsImage(imageCheckpoint, deferral);
    if (!checkpoint.execution) return { deferredHandoff: checkpoint };
    timing = { ...timing, resume: checkpoint.execution };
  }

  // Poll container status until FINISHED (required by Threads API)
  const statusEndpoint = `https://graph.threads.net/v1.0/${containerId}?fields=${CONTAINER_STATUS_FIELDS.threads}&access_token=${accessToken}`;
  const pollInterval = 2000; // 2 seconds
  const inlineImage = timing.resume?.inline === true && timing.resume.deferral.media_type === "IMAGE";
  // Only a single video can be finished later; a resumed run checks once, now.
  const deferrable = containerParams.media_type === "VIDEO" || containerParams.media_type === "CAROUSEL" ||
    (timing.resume?.deferral.media_type === "IMAGE");
  // The deadline bounds the requests as well as the sleeps, for every container.
  const container = await pollContainer("threads", statusEndpoint, {
    maxAttempts: inlineImage ? 1 : 15,
    intervalMs: pollInterval,
    checkFirst: inlineImage,
    // Inline images get one observation clipped to both the account and worker cutoffs.
    deadlineMs: timing.resume
      ? inlineImage ? deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS) : CHECK_ONCE_DEADLINE
      : deferrable ? deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS) : timing.deadlineMs,
  });

  // ERROR/EXPIRED after an unanswered send does not prove the provider rejected that send.
  if (container.state === "failed") {
    if (timing.resume && hasUnresolvedThreadsPublish(timing.resume.deferral)) {
      throw new ContainerStillProcessing("threads", containerId);
    }
    throw new Error(containerFailureMessage("threads", container.reason));
  }
  if (container.state === "waiting") {
    throw unfinishedError({ deadlineMs: timing.deadlineMs, deferKind: deferrable ? (containerParams.media_type === "CAROUSEL" ? "threads_carousel" : "threads") : undefined }, containerId, "Threads");
  }
  if (container.state === "published") {
    // Only a resumed run sees this: an earlier run published but died before recording it.
    // No id: the container id is not the post id, and analytics would read it as one.
    return {
      url: username ? `https://www.threads.com/@${username}` : undefined,
      warnings: [...threadsWarnings, "Threads had already published this post; its direct link could not be read."],
    };
  }

  // Publish the container
  console.log("Threads: Publishing container...");

  const publishUrl = new URL(publishEndpoint);
  publishUrl.searchParams.set("access_token", accessToken);
  publishUrl.searchParams.set("creation_id", containerId);

  const resumedImage = timing.resume?.deferral.media_type === "IMAGE" ? timing.resume : null;
  // FINISHED or a readable status failure after an unanswered send still cannot prove non-acceptance.
  if (resumedImage && hasUnresolvedThreadsPublish(resumedImage.deferral)) {
    throw new ContainerStillProcessing("threads", containerId);
  }

  const publishData = await publishThreadsContainer(async (timeoutMs) => {
    const response = await fetchWithTimeout(publishUrl.toString(), { method: "POST" }, timeoutMs);
    return await response.json();
  }, containerId, containerParams.media_type === "CAROUSEL" ? "threads_carousel" : "threads",
  workerPublishDeadline(WORKER_STARTED_AT_MS), Date.now, {
    beforeSend: resumedImage ? async () => {
      const marked = await resumedImage.markPublishStarted?.();
      if (!marked || "error" in marked || !marked.claimed) {
        throw new ThreadsCheckpointUnavailable("Threads image publish attempt could not be persisted; nothing was sent");
      }
    } : undefined,
    onDefinitelyUnsent: resumedImage?.releasePublishUnsent,
    onUnknown: resumedImage ? () => {
      resumedImage.deferral = withUnresolvedThreadsPublish(resumedImage.deferral);
    } : undefined,
  });
  tLocationDebug.publish_success = true;

  const postId = publishData.id;
  const followUpFetch = (url: string, init: RequestInit = {}) => {
    const timeoutMs = followUpTimeoutMs(WORKER_STARTED_AT_MS, Date.now());
    if (timeoutMs === 0) throw new Error("Threads follow-up skipped to preserve outcome recording time");
    return fetchWithTimeout(url, init, timeoutMs);
  };

  // Fetch permalink + verification fields. Helps us confirm what Meta actually
  // accepted (location_id, is_quote_post, shortcode) — surfaces silent ignores.
  let postUrl = username ? `https://www.threads.com/@${username}` : undefined;
  let verifyData: any = null;
  const crossShareStatus: string | null = null;
  try {
    const verifyRes = await followUpFetch(
      `https://graph.threads.net/v1.0/${postId}?fields=id,permalink,shortcode,is_quote_post,media_type,location,location_id,topic_tag,crossreshare_to_ig_status&access_token=${accessToken}`
    );
    verifyData = await verifyRes.json();
    if (verifyData && typeof verifyData === "object" && "topic_tag" in verifyData) {
      tTopicTagDebug.returned_by_meta = (verifyData as Record<string, unknown>).topic_tag as string | null ?? null;
    }
    if (verifyData?.permalink) {
      postUrl = String(verifyData.permalink).replace("https://www.threads.net/", "https://www.threads.com/");
      console.log("Threads: Got permalink:", postUrl);
    } else {
      console.warn("Threads: No permalink returned, using profile fallback");
    }
    console.log(`Threads: Verification fetch: ${JSON.stringify(verifyData).slice(0, 400)}`);

    // If we attempted cross-share, check Meta's acceptance status.
    if (crossShareApplied) {
      const igStatus = (verifyData as Record<string, unknown>)?.crossreshare_to_ig_status;
      const igStatusStr = typeof igStatus === "string" ? igStatus : "unknown";
      crossShareIgStatus = igStatusStr;
      if (igStatusStr === "SUCCESS") {
        console.log("Threads: Cross-share accepted by Meta — Story should appear within ~2 min.");
      } else if (igStatusStr === "FAILED") {
        threadsWarnings.push(
          "Meta did not accept the cross-share to Instagram. The Instagram account may not be linked in Meta Accounts Center."
        );
        console.warn("Threads: Cross-share rejected by Meta");
      } else {
        console.log(`Threads: Cross-share IG status: ${igStatusStr}`);
      }
    }
  } catch (e) {
    console.warn("Threads: Failed to fetch verification fields:", e);
    if (LOCATION_DEBUG_MODE) {
      tLocationDebug.post_publish_verify_attempted = true;
      tLocationDebug.post_publish_verify_result = "verification_failed";
      tLocationDebug.post_publish_verify_error = String((e as Error)?.message || e).slice(0, 200);
    }
  }

  // ── Location debug: post-publish verification & final reason ────────────
  if (LOCATION_DEBUG_MODE) {
    tLocationDebug.post_publish_verify_attempted = true;
    if (verifyData && !tLocationDebug.post_publish_verify_result) {
      const errMsg = String(verifyData?.error?.message || "").toLowerCase();
      const unknownField =
        errMsg.includes("unknown field") ||
        errMsg.includes("nonexisting field") ||
        errMsg.includes("does not exist on type");
      if (verifyData?.error && unknownField) {
        tLocationDebug.post_publish_verify_result = "verification_not_supported";
        if (tLocationDebug.container_params_had_location_id) {
          threadsWarnings.push(
            "Threads published successfully, but location verification is not supported by the current Meta endpoint."
          );
        }
      } else if (verifyData?.error) {
        tLocationDebug.post_publish_verify_result = "verification_failed";
        tLocationDebug.post_publish_verify_error = String(verifyData.error.message || "").slice(0, 200);
      } else {
        const locField = verifyData?.location ?? verifyData?.location_id ?? null;
        tLocationDebug.post_publish_location_field = locField ?? null;
        if (locField) {
          tLocationDebug.post_publish_verify_result = "location_attached";
        } else if (tLocationDebug.container_params_had_location_id) {
          tLocationDebug.post_publish_verify_result = "location_missing";
          threadsWarnings.push(
            "Threads published successfully, but Meta did not show the selected location on the final post."
          );
        } else {
          tLocationDebug.post_publish_verify_result = "verification_not_supported";
        }
      }
    }

    // Compute final reason
    const sel = tLocationDebug.selected_location_id;
    const skip = tLocationDebug.skipped_reason as string | null;
    const verify = tLocationDebug.post_publish_verify_result as string | null;
    let finalReason: string | null = null;
    if (!sel && !skip) finalReason = "no_location_selected";
    else if (skip === "osm_reference") finalReason = "reference_only_osm";
    else if (skip === "non_native_source" || skip === "unverified_source") finalReason = "non_native_threads_source";
    else if (skip === "not_taggable") finalReason = "not_taggable_by_meta";
    else if (sel && tLocationDebug.native_ok === false) finalReason = "non_native_threads_source";
    else if (tLocationDebug.create_container_success === false) finalReason = "meta_rejected_location";
    else if (tLocationDebug.publish_success === false) finalReason = "meta_rejected_location";
    else if (tLocationDebug.container_params_had_location_id === false && sel) finalReason = "location_id_not_included_in_request";
    else if (verify === "location_missing") finalReason = "meta_accepted_but_silent_drop";
    else if (verify === "verification_not_supported") finalReason = "verification_not_supported";
    else if (verify === "verification_failed") finalReason = "verification_failed";
    else if (verify === "location_attached") finalReason = null;
    else finalReason = "unknown";
    tLocationDebug.final_reason_location_not_visible = finalReason;
  }

  console.log(
    `Threads: Post created successfully! id=${postId} url=${postUrl} ` +
    `warnings=${JSON.stringify(threadsWarnings)}`
  );

  // ── First comment auto-reply (best-effort) ────────────────────────────
  // Same pattern as Instagram first_comment: never fail the main post if this fails.
  const rawFirstComment = (metadata?.threads_first_comment || "").toString().trim();
  if (rawFirstComment && postId && await claimFollowUps(timing.resume)) {
    try {
      let firstCommentText = rawFirstComment;
      if (firstCommentText.length > THREADS_CHAR_LIMIT) {
        const cut = firstCommentText.substring(0, THREADS_CHAR_LIMIT - 1);
        const lastSpace = cut.lastIndexOf(" ");
        firstCommentText = (lastSpace > 0 ? cut.substring(0, lastSpace) : cut) + "…";
      }

      const replyContainerUrl = new URL(containerEndpoint);
      replyContainerUrl.searchParams.set("access_token", accessToken);
      replyContainerUrl.searchParams.set("media_type", "TEXT");
      replyContainerUrl.searchParams.set("text", firstCommentText);
      replyContainerUrl.searchParams.set("reply_to_id", String(postId));

      console.log("Threads: Creating first-comment container…");
      const replyContainerRes = await followUpFetch(replyContainerUrl.toString(), { method: "POST" });
      const replyContainerData = await replyContainerRes.json().catch(() => ({}));

      if (replyContainerData?.error) {
        throw new Error(replyContainerData.error.message || "first-comment container failed");
      }
      const replyContainerId = replyContainerData?.id;
      if (!replyContainerId) throw new Error("No first-comment container id returned");

      // Poll status briefly
      const replyStatusUrl = `https://graph.threads.net/v1.0/${replyContainerId}?fields=status&access_token=${accessToken}`;
      const replyState = await pollContainer("threads", replyStatusUrl, {
        maxAttempts: 8, intervalMs: 1500,
        deadlineMs: Date.now() + followUpTimeoutMs(WORKER_STARTED_AT_MS, Date.now()),
      });
      if (replyState.state !== "finished") throw new Error("Threads first-comment container is not ready; main post remains published");

      const replyPublishUrl = new URL(publishEndpoint);
      replyPublishUrl.searchParams.set("access_token", accessToken);
      replyPublishUrl.searchParams.set("creation_id", replyContainerId);
      const replyPublishRes = await followUpFetch(replyPublishUrl.toString(), { method: "POST" });
      const replyPublishData = await replyPublishRes.json().catch(() => ({}));
      if (replyPublishData?.error) {
        throw new Error(replyPublishData.error.message || "first-comment publish failed");
      }
      console.log(`Threads: First comment posted (id=${replyPublishData?.id})`);
    } catch (firstCommentErr) {
      const msg = (firstCommentErr as Error).message || String(firstCommentErr);
      console.warn("Threads: First comment failed (non-fatal):", msg);
      threadsWarnings.push(`First comment failed: ${msg}`);
    }
  }

  return {
    id: postId,
    url: postUrl,
    cross_share: wantsCrossShare
      ? {
          requested: true,
          attempted: crossShareApplied,
          capability_at_publish: crossShareCapabilityAtPublish,
          dark_mode: !!metadata?.threads_cross_share_to_ig_dark_mode,
          status: crossShareIgStatus,
        }
      : undefined,
    ...(threadsWarnings.length > 0 ? { warnings: threadsWarnings } : {}),
    ...(LOCATION_DEBUG_MODE ? { location_debug: tLocationDebug } : {}),
    ...(rawTopicTagInput ? { topic_tag_debug: tTopicTagDebug } : {}),
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.8 TIKTOK                                                              │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Post to TikTok (video uploads only)
 */
async function postToTikTok(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  onPublishIdAssigned?: (publishId: string) => Promise<void>,
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;
  const metadata = post.metadata;

  console.log(`TikTok posting - mediaUrls received:`, mediaUrls);

  const reviewSubmissionId = requiredReviewSubmissionId(post);
  let reviewPostInfo: Record<string, unknown> | null = null;
  if (reviewSubmissionId) {
    const prepared = await prepareTikTokReviewPublish({
      admin: createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY),
      accessToken,
      submissionId: reviewSubmissionId,
      accountId: account.id,
      post: {
        id: post.id,
        user_id: post.user_id,
        caption: post.caption,
        media_file_ids: post.media_file_ids,
        scheduled_at: post.scheduled_at ?? null,
        metadata: (metadata ?? null) as Record<string, unknown> | null,
      },
    });
    reviewPostInfo = { ...prepared.postInfo };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Pre-flight check: Query creator_info to verify account privacy settings
  // ─────────────────────────────────────────────────────────────────────
  if (!reviewPostInfo) {
  console.log("TikTok: Checking creator info and account privacy...");
  try {
    const creatorInfoResponse = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );

    const creatorInfo = await creatorInfoResponse.json();
    console.log("TikTok creator_info response:", JSON.stringify(creatorInfo));

    if (creatorInfo?.error?.code && creatorInfo.error.code !== "ok") {
      const errorCode = creatorInfo.error.code;
      if (errorCode === "access_token_invalid") {
        throw new Error("TikTok session expired. Please reconnect your TikTok account.");
      }
      console.warn(`TikTok creator_info check warning: ${creatorInfo.error.message}`);
    } else if (creatorInfo?.data) {
      const data = creatorInfo.data;

      const privacyOptions = data.privacy_level_options || [];
      const maxVideoPostDuration = data.max_video_post_duration_sec;

      console.log(`TikTok account info - privacy options: ${JSON.stringify(privacyOptions)}, max duration: ${maxVideoPostDuration}s`);

      // Check if this is an unaudited client scenario
      if (privacyOptions.length === 1 && privacyOptions[0] === "SELF_ONLY") {
        console.warn("TikTok: Only SELF_ONLY privacy is available. This typically means the app is unaudited and the account must be set to private.");
      }

      // Warn if privacy options don't include the selected privacy level
      const selectedPrivacy = metadata?.tiktok_privacy_level || "SELF_ONLY";

      if (privacyOptions.length > 0 && !privacyOptions.includes(selectedPrivacy)) {
        throw new Error(
          `TikTok: The selected privacy level "${selectedPrivacy}" is not available for your account. ` +
          `Available options: ${privacyOptions.join(", ")}. ` +
          `This may be because your account is public and our app requires private accounts. ` +
          `Please set your TikTok account to PRIVATE in the TikTok app settings.`
        );
      }
    }
  } catch (preflightError) {
    if (preflightError instanceof Error && preflightError.message.includes("TikTok:")) {
      throw preflightError;
    }
    console.warn("TikTok pre-flight check failed, proceeding with post attempt:", preflightError);
  }
  }

  if (mediaUrls.length === 0) {
    throw new Error("TikTok requires media (video or photos)");
  }

  // Determine if it's a video or photo post
  const isVideo = mediaUrls.some(url => isVideoUrl(url));

  console.log(`TikTok post type: ${isVideo ? "video" : "photo"}, media count: ${mediaUrls.length}`);

  // Block photo posts - TikTok requires domain verification for photos
  if (!isVideo) {
    throw new Error(
      "TikTok currently supports video posts only. " +
      "Photo posts require domain verification which is not available yet. " +
      "Please use video content or choose another platform for images."
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // Video post - use FILE_UPLOAD to avoid URL ownership verification
  // ─────────────────────────────────────────────────────────────────────
  const videoUrl = mediaUrls[0];

  const { bytes: videoBytes, mimeType, size: videoSize } = await downloadMediaAsArrayBuffer(videoUrl);

  const MB = 1024 * 1024;

  // Chunking rules: each chunk 5-64MB, except final chunk can be larger
  let chunkSize = videoSize;
  let totalChunkCount = 1;

  if (videoSize > 64 * MB) {
    const baseChunkSize = 10 * MB;
    const fullChunks = Math.floor(videoSize / baseChunkSize);
    const remainder = videoSize - fullChunks * baseChunkSize;

    chunkSize = baseChunkSize;

    if (remainder === 0) {
      totalChunkCount = fullChunks;
    } else if (remainder < 5 * MB && fullChunks > 0) {
      totalChunkCount = fullChunks;
    } else {
      totalChunkCount = fullChunks + 1;
    }
  }

  // Get TikTok settings from post metadata
  let postInfo: Record<string, unknown>;
  if (reviewPostInfo) {
    postInfo = reviewPostInfo;
  } else {
  const privacyLevel = metadata?.tiktok_privacy_level || "SELF_ONLY";
  const disableComment = metadata?.tiktok_allow_comment === false;
  const disableDuet = metadata?.tiktok_allow_duet === false;
  const disableStitch = metadata?.tiktok_allow_stitch === false;
  const brandContentToggle = metadata?.tiktok_branded_content ?? false;
  const brandOrganicToggle = metadata?.tiktok_your_brand ?? false;
  const isAigc = metadata?.tiktok_ai_generated ?? false;

  console.log(`TikTok settings - privacy: ${privacyLevel}, comment: ${!disableComment}, duet: ${!disableDuet}, stitch: ${!disableStitch}`);

  // Build post_info with all TikTok settings
  // Use tiktok_title override if provided, otherwise fall back to main caption
  const titleToUse = (metadata?.tiktok_title && metadata.tiktok_title.trim())
    ? metadata.tiktok_title
    : (post.caption || "");

  console.log(`TikTok title - using override: ${!!metadata?.tiktok_title?.trim()}, title: "${titleToUse.substring(0, 50)}..."`);

  postInfo = {
    privacy_level: privacyLevel,
    title: titleToUse?.substring(0, 2200) || "",
    disable_comment: disableComment,
    disable_duet: disableDuet,
    disable_stitch: disableStitch,
  };

  // Add brand content disclosure if enabled
  if (brandContentToggle || brandOrganicToggle) {
    postInfo.brand_content_toggle = brandContentToggle;
    postInfo.brand_organic_toggle = brandOrganicToggle;
  }

  // Add AI-generated content flag if enabled
  if (isAigc) {
    postInfo.is_aigc = true;
  }
  }

  // Step 1: Initialize the upload
  console.log("TikTok: Initializing video upload...");

  const initBody = {
    post_info: postInfo,
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount,
    },
  };

  const initResponse = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initBody),
    }
  );

  const initData = await initResponse.json();
  console.log("TikTok init response:", JSON.stringify(initData));

  if (initData?.error?.code && initData.error.code !== "ok") {
    const errorCode = initData.error.code;
    const errorMessage = initData.error.message || "Unknown error";

    if (errorCode === "access_token_invalid") {
      throw new Error("TikTok session expired. Please reconnect your TikTok account.");
    }
    if (errorCode === "scope_not_authorized") {
      throw new Error("TikTok permissions missing. Please reconnect with video.upload scope.");
    }
    if (errorCode === "unaudited_client_can_only_post_to_private_accounts") {
      throw new Error(
        "TikTok requires your account to be set to PRIVATE in your TikTok app settings. " +
        "Go to TikTok app → Settings → Privacy → Private Account → Turn ON. " +
        "This is required for unaudited API clients, separate from the post privacy setting."
      );
    }

    throw new Error(`TikTok error: ${errorMessage} (${errorCode})`);
  }

  const publishId: string | undefined = initData?.data?.publish_id;
  const uploadUrl: string | undefined = initData?.data?.upload_url;

  if (!publishId || !uploadUrl) {
    throw new Error("TikTok upload init failed: missing publish_id or upload_url");
  }

  if (onPublishIdAssigned) {
    try {
      await onPublishIdAssigned(publishId);
    } catch (recordError) {
      // Without a recorded publish id nothing can reconcile this attempt, so
      // stop before uploading: an init with no upload never goes live.
      console.error(
        "tiktok_review_publish_id_record_failed",
        recordError instanceof Error ? recordError.message : "unknown",
      );
      throw new Error("TIKTOK_REVIEW_NEEDS_ATTENTION:PUBLISH_ID_RECORD_FAILED");
    }
  }

  console.log(
    `TikTok uploading video: size=${videoSize}, chunkSize=${chunkSize}, totalChunks=${totalChunkCount}`
  );

  // Step 2: Upload video chunks
  let offset = 0;
  for (let i = 0; i < totalChunkCount; i++) {
    const isLastChunk = i === totalChunkCount - 1;
    const endExclusive = isLastChunk ? videoSize : Math.min(offset + chunkSize, videoSize);
    const chunk = videoBytes.slice(offset, endExclusive);

    const startByte = offset;
    const endByte = endExclusive - 1;

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${startByte}-${endByte}/${videoSize}`,
      },
      body: chunk,
    });

    if (!uploadRes.ok) {
      const bodyText = await uploadRes.text().catch(() => "");
      throw new Error(
        `TikTok upload failed (${uploadRes.status}): ${bodyText.slice(0, 200)}`
      );
    }

    offset = endExclusive;
  }

  // Step 3: Poll for publish status
  console.log(`TikTok: Polling publish status for publish_id: ${publishId}`);

  let postUrl: string | undefined;
  let providerPostId: string | undefined;
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResponse = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publish_id: publishId }),
      }
    );

    const statusData = await statusResponse.json();
    console.log(`TikTok publish status (attempt ${attempts + 1}):`, JSON.stringify(statusData));

    if (statusData?.error?.code && statusData.error.code !== "ok") {
      throw new Error(`TikTok status check failed: ${statusData.error.message}`);
    }

    const status = statusData?.data?.status;

    if (status === "PUBLISH_COMPLETE") {
      const publiclyAvailablePostId = firstPublicPostId(statusData?.data?.publicaly_available_post_id);
      providerPostId = publiclyAvailablePostId ?? undefined;
      // Use creator_username from earlier API response if available, fallback to account.platform_username
      // TikTok API returns the actual handle in creator_info response
      const tiktokHandle = (account.account_metadata as Record<string, unknown>)?.tiktok_username ||
        account.platform_username ||
        "user";
      if (publiclyAvailablePostId) {
        postUrl = `https://www.tiktok.com/@${tiktokHandle}/video/${publiclyAvailablePostId}`;
      }
      console.log(`TikTok: Video published successfully! Post ID: ${publiclyAvailablePostId || "unknown"}, URL: ${postUrl || "pending"}`);
      break;
    } else if (status === "FAILED") {
      const failReason = statusData?.data?.fail_reason || "Unknown reason";

      if (failReason === "picture_size_check_failed") {
        throw new Error(
          `TikTok rejected this upload because the video dimensions/resolution aren't supported. ` +
          `Please upload a vertical 9:16 MP4 (recommended 720×1280 or higher) and try again.`
        );
      }

      throw new Error(`TikTok publish failed: ${failReason}`);
    } else if (status === "PROCESSING_UPLOAD" || status === "PROCESSING_DOWNLOAD" || status === "SENDING_TO_USER_INBOX") {
      attempts++;
    } else {
      console.log(`TikTok: Unknown status "${status}", continuing to poll...`);
      attempts++;
    }
  }

  if (attempts >= maxAttempts) {
    console.warn("TikTok: Status polling timed out, video may still be processing");
  }

  // Return publishId as the ID (for background polling) and postUrl if available
  // For unaudited API, postUrl may be undefined initially until background polling completes
  return {
    id: publishId,
    url: postUrl,
    providerPostId,
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.9 TWITTER / X                                                         │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Split text into tweet-sized chunks while respecting word boundaries
 */
function splitIntoTweets(text: string, maxLength: number = 280): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const tweets: string[] = [];
  let remainingText = text;
  let tweetIndex = 1;

  while (remainingText.length > 0) {
    // Reserve space for thread indicator (e.g., "1/5 " = 6 chars max)
    const threadIndicatorSpace = 6;
    const effectiveMaxLength = maxLength - threadIndicatorSpace;

    if (remainingText.length <= effectiveMaxLength) {
      tweets.push(remainingText.trim());
      break;
    }

    // Find a good break point (prefer sentence/paragraph, then word boundary)
    let breakPoint = effectiveMaxLength;

    // Try to break at paragraph
    const paragraphBreak = remainingText.lastIndexOf("\n\n", effectiveMaxLength);
    if (paragraphBreak > effectiveMaxLength * 0.5) {
      breakPoint = paragraphBreak;
    } else {
      // Try to break at sentence
      const sentenceEnders = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
      let lastSentenceEnd = -1;
      for (const ender of sentenceEnders) {
        const idx = remainingText.lastIndexOf(ender, effectiveMaxLength);
        if (idx > lastSentenceEnd && idx > effectiveMaxLength * 0.4) {
          lastSentenceEnd = idx + ender.length - 1;
        }
      }

      if (lastSentenceEnd > effectiveMaxLength * 0.4) {
        breakPoint = lastSentenceEnd;
      } else {
        // Break at word boundary
        const lastSpace = remainingText.lastIndexOf(" ", effectiveMaxLength);
        if (lastSpace > effectiveMaxLength * 0.3) {
          breakPoint = lastSpace;
        }
      }
    }

    const chunk = remainingText.substring(0, breakPoint).trim();
    tweets.push(chunk);
    remainingText = remainingText.substring(breakPoint).trim();
    tweetIndex++;

    // Safety check to prevent infinite loops
    if (tweetIndex > 25) {
      if (remainingText.length > 0) {
        tweets.push(remainingText);
      }
      break;
    }
  }

  return tweets;
}

/**
 * Add thread numbers to tweets (e.g., "1/5", "2/5")
 */
function addThreadNumbers(tweets: string[]): string[] {
  if (tweets.length <= 1) return tweets;

  return tweets.map((tweet, index) => {
    const threadIndicator = `${index + 1}/${tweets.length}`;
    return `${threadIndicator} ${tweet}`;
  });
}

/**
 * Post to Twitter/X (single tweets, threads, with media)
 */
async function postToTwitter(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  supabase: SupabaseClient
): Promise<PlatformPostResult> {
  let accessToken = account.access_token;
  const username = account.platform_username;
  const metadata = post.metadata;

  // ─────────────────────────────────────────────────────────────────────
  // Check if we need to refresh the token
  // ─────────────────────────────────────────────────────────────────────
  const { data: accountData } = await supabase
    .from("social_accounts")
    .select("token_expires_at, refresh_token")
    .eq("id", account.id)
    .single();

  if (accountData?.token_expires_at) {
    const expiresAt = new Date(accountData.token_expires_at);
    const now = new Date();
    // Refresh if token expires within 5 minutes
    if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      console.log("Twitter: Token expiring soon, refreshing...");
      try {
        const refreshResponse = await fetch(
          `${SUPABASE_URL}/functions/v1/twitter-oauth`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({
              action: "refresh",
              account_id: account.id,
              refresh_token: accountData.refresh_token,
            }),
          }
        );

        if (refreshResponse.ok) {
          const { data: refreshedAccount } = await supabase
            .from("social_accounts")
            .select("access_token")
            .eq("id", account.id)
            .single();
          if (refreshedAccount?.access_token) {
            accessToken = refreshedAccount.access_token;
            console.log("Twitter: Token refreshed successfully");
          }
        }
      } catch (refreshError) {
        console.warn("Twitter: Token refresh failed, continuing with current token:", refreshError);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Upload media if present
  // ─────────────────────────────────────────────────────────────────────
  const mediaIds: string[] = [];

  // Helper: convert ArrayBuffer to base64 without stack overflow
  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  for (const mediaUrl of mediaUrls) {
    try {
      console.log(`Twitter: Uploading media from ${mediaUrl.substring(0, 100)}...`);

      // Download the media file
      const mediaResponse = await fetch(mediaUrl);
      if (!mediaResponse.ok) {
        console.error(`Twitter: Failed to download media: ${mediaResponse.status}`);
        continue;
      }

      const mediaBlob = await mediaResponse.blob();
      const mediaArrayBuffer = await mediaBlob.arrayBuffer();
      const mediaBase64 = arrayBufferToBase64(mediaArrayBuffer);

      // Determine media type
      const contentType = mediaResponse.headers.get("content-type") || "image/jpeg";
      const isVideo = contentType.startsWith("video/");

      if (isVideo) {
        // For video, use chunked upload
        console.log("Twitter: Video detected, using chunked upload...");

        // INIT
        const initResponse = await fetch(
          "https://upload.twitter.com/1.1/media/upload.json",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
            },
            body: new URLSearchParams({
              command: "INIT",
              total_bytes: mediaArrayBuffer.byteLength.toString(),
              media_type: contentType,
              media_category: "tweet_video",
            }),
          }
        );

        if (!initResponse.ok) {
          const error = await initResponse.text();
          console.error("Twitter: Media INIT failed:", error);
          continue;
        }

        const initData = await initResponse.json();
        const mediaIdString = initData.media_id_string;

        // APPEND - send in chunks (5MB max per chunk)
        const chunkSize = 5 * 1024 * 1024;
        const chunks = Math.ceil(mediaArrayBuffer.byteLength / chunkSize);

        for (let i = 0; i < chunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, mediaArrayBuffer.byteLength);
          const chunk = mediaArrayBuffer.slice(start, end);
          const chunkBase64 = arrayBufferToBase64(chunk);

          const appendResponse = await fetch(
            "https://upload.twitter.com/1.1/media/upload.json",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
              },
              body: new URLSearchParams({
                command: "APPEND",
                media_id: mediaIdString,
                media_data: chunkBase64,
                segment_index: i.toString(),
              }),
            }
          );

          if (!appendResponse.ok) {
            const error = await appendResponse.text();
            console.error(`Twitter: Media APPEND chunk ${i} failed:`, error);
            break;
          }
        }

        // FINALIZE
        const finalizeResponse = await fetch(
          "https://upload.twitter.com/1.1/media/upload.json",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
            },
            body: new URLSearchParams({
              command: "FINALIZE",
              media_id: mediaIdString,
            }),
          }
        );

        if (!finalizeResponse.ok) {
          const error = await finalizeResponse.text();
          console.error("Twitter: Media FINALIZE failed:", error);
          continue;
        }

        const finalizeData = await finalizeResponse.json();

        // Check processing status if needed
        if (finalizeData.processing_info) {
          let checkAfterSecs = finalizeData.processing_info.check_after_secs || 5;
          let status = finalizeData.processing_info.state;

          while (status === "pending" || status === "in_progress") {
            await new Promise(resolve => setTimeout(resolve, checkAfterSecs * 1000));

            const statusResponse = await fetch(
              `https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=${mediaIdString}`,
              {
                headers: {
                  "Authorization": `Bearer ${accessToken}`,
                },
              }
            );

            const statusData = await statusResponse.json();
            status = statusData.processing_info?.state;
            checkAfterSecs = statusData.processing_info?.check_after_secs || 5;

            if (status === "failed") {
              console.error("Twitter: Video processing failed:", statusData.processing_info?.error);
              break;
            }
          }

          if (status !== "succeeded") {
            console.error("Twitter: Video processing did not succeed");
            continue;
          }
        }

        mediaIds.push(mediaIdString);
        console.log(`Twitter: Video uploaded successfully, media_id: ${mediaIdString}`);

      } else {
        // For images, use simple upload
        const uploadResponse = await fetch(
          "https://upload.twitter.com/1.1/media/upload.json",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              media_data: mediaBase64,
            }),
          }
        );

        if (!uploadResponse.ok) {
          const error = await uploadResponse.text();
          console.error("Twitter: Media upload failed:", error);
          continue;
        }

        const uploadData = await uploadResponse.json();
        mediaIds.push(uploadData.media_id_string);
        console.log(`Twitter: Image uploaded successfully, media_id: ${uploadData.media_id_string}`);
      }
    } catch (mediaError) {
      console.error("Twitter: Media upload error:", mediaError);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Build tweet payload
  // ─────────────────────────────────────────────────────────────────────
  const tweetText = metadata?.twitter_custom_title || post.caption || "";

  const tweetPayload: Record<string, unknown> = {
    text: tweetText,
  };

  // Add media if uploaded
  if (mediaIds.length > 0) {
    const mediaPayload: Record<string, unknown> = {
      media_ids: mediaIds,
    };

    // Add tagged user IDs if provided
    if (metadata?.twitter_tagged_user_ids && metadata.twitter_tagged_user_ids.length > 0) {
      mediaPayload.tagged_user_ids = metadata.twitter_tagged_user_ids;
    }

    tweetPayload.media = mediaPayload;
  }

  // Add poll if enabled
  if (metadata?.twitter_poll_enabled && metadata.twitter_poll_options?.length) {
    const validOptions = metadata.twitter_poll_options.filter(opt => opt.trim());
    if (validOptions.length >= 2) {
      tweetPayload.poll = {
        options: validOptions,
        duration_minutes: metadata.twitter_poll_duration || 1440,
      };
    }
  }

  // Add reply settings
  if (metadata?.twitter_reply_settings && metadata.twitter_reply_settings !== "everyone") {
    const replySettingsMap: Record<string, string> = {
      following: "following",
      mentionedUsers: "mentionedUsers",
      subscribers: "following",
      verified: "mentionedUsers",
    };
    const mappedSetting = replySettingsMap[metadata.twitter_reply_settings];
    if (mappedSetting) {
      tweetPayload.reply_settings = mappedSetting;
    }
  }

  // Add reply to tweet ID
  if (metadata?.twitter_reply_to_tweet_id) {
    const replyPayload: Record<string, unknown> = {
      in_reply_to_tweet_id: metadata.twitter_reply_to_tweet_id,
    };

    if (metadata.twitter_exclude_reply_user_ids && metadata.twitter_exclude_reply_user_ids.length > 0) {
      replyPayload.exclude_reply_user_ids = metadata.twitter_exclude_reply_user_ids;
    }

    tweetPayload.reply = replyPayload;
  }

  // Add quote tweet if specified
  if (metadata?.twitter_quote_tweet_url) {
    const tweetIdMatch = metadata.twitter_quote_tweet_url.match(/status\/(\d+)/);
    if (tweetIdMatch) {
      tweetPayload.quote_tweet_id = tweetIdMatch[1];
    } else if (/^\d+$/.test(metadata.twitter_quote_tweet_url)) {
      tweetPayload.quote_tweet_id = metadata.twitter_quote_tweet_url;
    }
  }

  // Add geo/place tagging
  if (metadata?.twitter_place_id) {
    tweetPayload.geo = {
      place_id: metadata.twitter_place_id,
    };
  }

  // Add for super followers only
  if (metadata?.twitter_for_super_followers_only) {
    tweetPayload.for_super_followers_only = true;
  }

  // Add DM deep link
  if (metadata?.twitter_dm_deep_link && !tweetText.includes(metadata.twitter_dm_deep_link)) {
    tweetPayload.text = `${tweetText}\n\n${metadata.twitter_dm_deep_link}`;
  }

  console.log("Twitter: Creating tweet with settings:", {
    hasMedia: mediaIds.length > 0,
    hasReply: !!metadata?.twitter_reply_to_tweet_id,
    hasQuote: !!metadata?.twitter_quote_tweet_url,
    threadMode: metadata?.twitter_thread_mode,
  });

  // ─────────────────────────────────────────────────────────────────────
  // Thread Mode: Split long tweets into multiple tweets
  // ─────────────────────────────────────────────────────────────────────
  if (metadata?.twitter_thread_mode && tweetText.length > 280) {
    console.log("Twitter: Thread mode enabled, splitting into multiple tweets...");

    const tweetChunks = splitIntoTweets(tweetText, 280);
    const numberedTweets = addThreadNumbers(tweetChunks);

    console.log(`Twitter: Split into ${numberedTweets.length} tweets`);

    let previousTweetId: string | null = metadata?.twitter_reply_to_tweet_id || null;
    let firstTweetId: string | null = null;
    let firstTweetUrl: string | null = null;

    for (let i = 0; i < numberedTweets.length; i++) {
      const tweetContent = numberedTweets[i];
      const isFirstTweet = i === 0;

      const threadTweetPayload: Record<string, unknown> = {
        text: tweetContent,
      };

      // Add media only to the first tweet
      if (isFirstTweet && mediaIds.length > 0) {
        const mediaPayload: Record<string, unknown> = {
          media_ids: mediaIds,
        };
        if (metadata?.twitter_tagged_user_ids && metadata.twitter_tagged_user_ids.length > 0) {
          mediaPayload.tagged_user_ids = metadata.twitter_tagged_user_ids;
        }
        threadTweetPayload.media = mediaPayload;
      }

      // Add reply settings only to first tweet
      if (isFirstTweet && metadata?.twitter_reply_settings && metadata.twitter_reply_settings !== "everyone") {
        const replySettingsMap: Record<string, string> = {
          following: "following",
          mentionedUsers: "mentionedUsers",
          subscribers: "following",
          verified: "mentionedUsers",
        };
        const mappedSetting = replySettingsMap[metadata.twitter_reply_settings];
        if (mappedSetting) {
          threadTweetPayload.reply_settings = mappedSetting;
        }
      }

      // Make subsequent tweets replies to the previous tweet
      if (previousTweetId) {
        threadTweetPayload.reply = {
          in_reply_to_tweet_id: previousTweetId,
        };
      }

      // Add quote tweet only to first tweet
      if (isFirstTweet && metadata?.twitter_quote_tweet_url) {
        const tweetIdMatch = metadata.twitter_quote_tweet_url.match(/status\/(\d+)/);
        if (tweetIdMatch) {
          threadTweetPayload.quote_tweet_id = tweetIdMatch[1];
        } else if (/^\d+$/.test(metadata.twitter_quote_tweet_url)) {
          threadTweetPayload.quote_tweet_id = metadata.twitter_quote_tweet_url;
        }
      }

      // Add geo only to first tweet
      if (isFirstTweet && metadata?.twitter_place_id) {
        threadTweetPayload.geo = {
          place_id: metadata.twitter_place_id,
        };
      }

      console.log(`Twitter: Posting thread tweet ${i + 1}/${numberedTweets.length}...`);

      const threadTweetResponse = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(threadTweetPayload),
      });

      const threadTweetData = await threadTweetResponse.json();

      if (!threadTweetResponse.ok) {
        console.error(`Twitter: Thread tweet ${i + 1} failed:`, threadTweetData);
        if (firstTweetId) {
          return {
            id: firstTweetId,
            url: firstTweetUrl || undefined,
          };
        }
        throw new Error(`Twitter thread failed at tweet ${i + 1}: ${threadTweetData.detail || threadTweetData.title || "Unknown error"}`);
      }

      const newTweetId = threadTweetData.data?.id;
      previousTweetId = newTweetId;

      if (isFirstTweet) {
        firstTweetId = newTweetId;
        firstTweetUrl = username ? `https://x.com/${username}/status/${newTweetId}` : `https://x.com/i/status/${newTweetId}`;
      }

      // Small delay between tweets to avoid rate limiting
      if (i < numberedTweets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`Twitter: Thread posted successfully! ${numberedTweets.length} tweets. First tweet: ${firstTweetUrl}`);

    return {
      id: firstTweetId || undefined,
      url: firstTweetUrl || undefined,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Standard single tweet posting
  // ─────────────────────────────────────────────────────────────────────
  console.log("Twitter: Tweet payload preview:", JSON.stringify(tweetPayload).substring(0, 500));

  const tweetResponse = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tweetPayload),
  });

  const tweetData = await tweetResponse.json();
  console.log("Twitter: Tweet response status:", tweetResponse.status);

  if (!tweetResponse.ok) {
    console.error("Twitter: Tweet creation failed:", tweetData);

    if (tweetResponse.status === 401) {
      throw new Error("Twitter authentication expired. Please reconnect your Twitter/X account.");
    }
    if (tweetResponse.status === 403) {
      const errorDetail = tweetData.detail || tweetData.errors?.[0]?.message || "";
      if (errorDetail.toLowerCase().includes("duplicate")) {
        throw new Error("Twitter rejected this tweet as a duplicate. Please modify the content.");
      }
      if (errorDetail.toLowerCase().includes("credit") || errorDetail.toLowerCase().includes("enrolled account")) {
        throw new Error("Twitter/X API credits exhausted — your X Developer account has no remaining credits. Please upgrade your plan at developer.x.com to continue posting.");
      }
      throw new Error(`Twitter permission denied: ${errorDetail}`);
    }
    if (tweetData.errors) {
      throw new Error(`Twitter API error: ${tweetData.errors[0]?.message || JSON.stringify(tweetData.errors)}`);
    }
    throw new Error(`Twitter API error: ${tweetData.detail || tweetData.title || "Unknown error"}`);
  }

  const tweetId = tweetData.data?.id;
  const tweetUrl = username ? `https://x.com/${username}/status/${tweetId}` : `https://x.com/i/status/${tweetId}`;

  console.log(`Twitter: Tweet created successfully! URL: ${tweetUrl}`);

  return {
    id: tweetId,
    url: tweetUrl,
  };
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 5.10 YOUTUBE                                                            │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * The CDN origins Postora is willing to read a media file from.
 *
 * The list is built from the running configuration, so a deployment that
 * moves its storage or its CDN keeps working. The storage host comes from
 * `SUPABASE_URL`, and the CDN origin comes from the admin-configured
 * `cdn_storage` setting.
 *
 * A media host that is not on this list never receives a request: the check
 * runs before the first byte is asked for, and again for every redirect hop.
 */
async function approvedMediaHostSet(supabase: SupabaseClient): Promise<Set<string>> {
  const origins: string[] = [];
  try {
    const { data: cdnSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "cdn_storage")
      .maybeSingle();
    const serverUrl = (cdnSetting?.value as { openinary?: { serverUrl?: string } } | null)?.openinary?.serverUrl;
    if (typeof serverUrl === "string") origins.push(serverUrl);
  } catch (error) {
    console.warn("[process-post] cdn_storage read failed for the media host policy:", redactProviderText(error));
  }
  return approvedMediaHosts({ supabaseUrl: publicSupabaseUrl(), cdnOrigins: origins });
}

/**
 * The message a YouTube upload refusal becomes.
 *
 * The wording matters as much as the branch: a refusal that needs a human
 * must never read like "safe to try again", because trying again could put a
 * second video on the customer's channel.
 */
function youtubeUploadRefusalMessage(refusal: YoutubeUploadRefusal): string {
  switch (refusal) {
    case "reconcile_required":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.reconcile);
    case "content_changed":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.superseded);
    case "lease_held":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.lease_conflict);
    case "account_not_usable":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.account_unusable);
    case "media_not_owned":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.media_unavailable);
    case "post_not_found":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.not_found);
    case "invalid_size":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.media_unavailable);
    case "stale_attempt":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.stale_attempt);
    case "post_superseded":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.superseded);
    case "session_expired":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.expired);
    case "too_many_continuations":
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.reconcile);
    case "channel_may_have_published":
      // The channel may already hold a video of this post, so the refusal
      // reads like the reconcile it is: a human has to look before anything is
      // sent again.
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.reconcile);
    default:
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.unknown);
  }
}

/**
 * The message an upload outcome becomes.
 *
 * The three cases the protocol keeps apart are three different messages: one
 * that says the upload never started and is safe to try again, one that says
 * it can continue where it stopped, and one that says a human has to look.
 */

/**
 * Admits the durable upload session and takes it for this worker.
 *
 * The admission creates the private session AND the public pending row in one
 * transaction, before the provider is contacted at all. That is what closes
 * the window where a post had a pending row that no continuation could claim.
 *
 * The session is admitted first and claimed second, and the pair is tried
 * twice: a session whose provider session expired between the two calls is
 * reopened by the second round, and a session that was reopened is claimed
 * with the same lease.
 */
async function openYoutubeUploadSession(
  store: ReturnType<typeof createSupabaseYoutubeUploadSessionStore>,
  input: Parameters<ReturnType<typeof createSupabaseYoutubeUploadSessionStore>["admit"]>[0],
  leaseToken: string,
  leaseMs: number,
): Promise<{
  record: Awaited<ReturnType<typeof store.claim>>["record"];
  refused: YoutubeUploadRefusal | null;
  platformPostId: string | null;
}> {
  for (let round = 0; round < 2; round += 1) {
    const opened = await store.admit(input);
    if (opened.refused) return { record: null, refused: opened.refused, platformPostId: null };
    if (!opened.record) return { record: null, refused: "post_not_found", platformPostId: null };

    const claimed = await store.claim({
      sessionId: opened.record.id,
      leaseToken,
      leaseMs,
    });
    if (!claimed.refused) return { ...claimed, platformPostId: opened.platformPostId };
    if (claimed.refused !== "session_expired") return { ...claimed, platformPostId: opened.platformPostId };
  }
  return { record: null, refused: "session_expired", platformPostId: null };
}

/**
 * Settles the public row of one YouTube upload.
 *
 * The settlement is fenced: only the worker that still owns the upload may
 * record the outcome, and the public row and the parent rollup are settled in
 * one transaction. A worker that lost its lease settles nothing, because the
 * worker that took over may already have written the video.
 *
 * The answer may also be LOST: the write may have committed and the reply
 * never arrive. That is not a failure of the upload, it is a failure to PROVE
 * it. So this never throws, and it says what happened: the row is left to the
 * upload recovery either way, because the row exists and it belongs to this
 * attempt.
 */
async function settleYoutubeUpload(
  store: ReturnType<typeof createSupabaseYoutubeUploadSessionStore>,
  sessionId: string,
  leaseToken: string,
  args: {
    status: "success" | "failed";
    videoId?: string | null;
    errorMessage?: string | null;
    responseData?: Record<string, unknown>;
  },
): Promise<{ confirmed: boolean; reason: string | null }> {
  try {
    const settled = await store.settle({
      sessionId,
      leaseToken,
      status: args.status,
      videoId: args.videoId ?? null,
      errorMessage: args.errorMessage ?? null,
      responseData: args.responseData ?? {},
    });
    if (!settled.settled) {
      console.error(`[youtube] the upload outcome was not recorded: ${settled.refused ?? "unknown"}`);
      return { confirmed: false, reason: settled.refused ?? "unknown" };
    }
    return { confirmed: true, reason: null };
  } catch (error) {
    console.error("[youtube] the upload outcome was not confirmed:", redactProviderText(error));
    return { confirmed: false, reason: "answer_lost" };
  }
}

/**
 * How large a thumbnail may be.
 *
 * A thumbnail is an image for a video, and the provider refuses anything that
 * is not one. The bound is here so a host that answers with a stream of any
 * size cannot fill the worker's memory.
 */
const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The boundary of the YouTube follow-ups.
 *
 * The thumbnail is read from the URL the customer gave, and the read is
 * bounded by what is left of the worker: a host that accepts the connection
 * and then stops sending must not hold the worker, because the worker is the
 * only thing that may settle the outcome.
 *
 * The read also goes through the media host policy: only HTTPS, only a host
 * Postora reviewed, and every redirect hop checked again before it is made. A
 * thumbnail that does not come from a reviewed host is not read at all: the
 * worker must never be talked into fetching an internal address.
 *
 * The budget is asked for EVERY follow-up, not once for both of them, so the
 * second one is skipped rather than started when the worker has already run
 * out of time.
 */
function youtubeFollowUpDeps(mediaHosts: Set<string>): YoutubeFollowUpDeps {
  return {
    fetchImpl: fetch,
    async downloadThumbnail(url, timeoutMs) {
      const response = await fetchApprovedMedia(
        url,
        { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
        mediaHosts,
        fetch,
      );
      if (!response.ok) {
        throw new Error(`The thumbnail host answered with ${response.status}.`);
      }
      const bytes = await readBoundedBytes(response, THUMBNAIL_MAX_BYTES);
      const mimeType = (response.headers.get("content-type") ?? "image/jpeg")
        .split(";")[0]
        .trim();
      return { blob: new Blob([bytes], { type: mimeType }), mimeType };
    },
    budgetMs: () => followUpTimeoutMs(WORKER_STARTED_AT_MS, Date.now()),
  };
}

/**
 * Binds the database and the provider to the continuation's port contract.
 *
 * The ports are the boundary: everything the continuation reads or writes goes
 * through them, so the worker itself never touches the database and never
 * learns a provider's URL.
 */
function buildYoutubeContinuationPorts(
  supabase: SupabaseClient,
  store: ReturnType<typeof createSupabaseYoutubeUploadSessionStore>,
  mediaHosts: Set<string>,
  deadlineMs: number,
): YoutubeContinuationPorts {
  return {
    async loadPost(id) {
      const { data } = await supabase
        .from("posts")
        .select("id, user_id, status, processing_started_at, metadata, media_file_ids")
        .eq("id", id)
        .maybeSingle();
      if (!data) return null;
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      const selected = Array.isArray(metadata.selected_account_ids)
        ? metadata.selected_account_ids.filter((value): value is string => typeof value === "string")
        : [];
      return {
        id: String(data.id),
        userId: String(data.user_id),
        status: String(data.status),
        processingStartedAt: typeof data.processing_started_at === "string" ? data.processing_started_at : null,
        selectedAccountIds: selected,
        mediaFileIds: Array.isArray(data.media_file_ids)
          ? data.media_file_ids.filter((value): value is string => typeof value === "string")
          : [],
        thumbnailUrl: typeof metadata.youtube_thumbnail_url === "string" ? metadata.youtube_thumbnail_url : null,
        firstComment: typeof metadata.youtube_first_comment === "string" ? metadata.youtube_first_comment : null,
      };
    },

    async loadAccount(accountId) {
      const { data } = await supabase
        .from("social_accounts")
        .select("id, user_id, platform, is_active, access_token, refresh_token, token_expires_at, account_metadata, needs_reauth")
        .eq("id", accountId)
        .maybeSingle();
      if (!data) return null;
      const metadata = (data.account_metadata ?? {}) as Record<string, unknown>;

      // The token is refreshed the way the publishing path refreshes it.
      //
      // A continuation starts long after the publish did, and a token that
      // expired in between turns a resumable upload into a refusal that says
      // nothing about the video. The receipt-only recovery does NOT come here:
      // it settles a stored receipt and never talks to the provider.
      const token = await refreshYoutubeAccessToken({
        supabase,
        account: {
          id: String(data.id),
          accessToken: typeof data.access_token === "string" ? data.access_token : null,
          refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
          tokenExpiresAt: typeof data.token_expires_at === "string" ? data.token_expires_at : null,
        },
      });

      return {
        id: String(data.id),
        userId: String(data.user_id),
        platform: String(data.platform),
        isActive: data.is_active !== false,
        accessToken: token.accessToken,
        needsReauth: data.needs_reauth === true || metadata.needs_reauth === true,
      };
    },

    async loadMedia(mediaFileId) {
      const { data } = await supabase
        .from("media_files")
        .select("id, user_id, current_object_version, file_path, storage_bucket, mime_type, scan_state, file_size")
        .eq("id", mediaFileId)
        .maybeSingle();
      if (!data) return null;
      return {
        id: String(data.id),
        userId: String(data.user_id),
        currentObjectVersion: data.current_object_version === null || data.current_object_version === undefined
          ? null
          : Number(data.current_object_version),
        // The size of the file as it is now. A resumed upload has to send the
        // file the offset was established for, so the size is compared with
        // the total the session persisted.
        fileSize: data.file_size === null || data.file_size === undefined
          ? null
          : Number(data.file_size),
        filePath: String(data.file_path),
        // The bucket is part of the file's identity: a signed URL is only
        // made for the bucket the object is actually in.
        storageBucket: String(data.storage_bucket ?? ""),
        mimeType: typeof data.mime_type === "string" ? data.mime_type : null,
        // The shared sendability rule reads this. A resumed upload refuses a
        // file that is still being scanned or that was rejected, exactly as
        // every other send path does.
        scanState: typeof data.scan_state === "string" ? data.scan_state : null,
      };
    },

    async claimSession(id, token, leaseMs) {
      return await store.claim({ sessionId: id, leaseToken: token, leaseMs });
    },

    async createSource({ media }) {
      // The source is rebuilt the way publishing builds it: from the file's own
      // bucket and from the provider rows that match its CURRENT content
      // version. A hard-coded bucket or a stale provider row would upload
      // bytes that are not the video the post names.
      return await createOwnedVideoSource({
        supabase,
        file: {
          id: media.id,
          userId: media.userId,
          filePath: media.filePath,
          storageBucket: media.storageBucket,
          mimeType: media.mimeType,
          currentObjectVersion: media.currentObjectVersion,
        },
        mediaHosts,
      });
    },

    async runUpload({ record, leaseToken: token, accessToken, source, totalBytes, mimeType }) {
      return await runResumableVideoUpload({
        fetchImpl: fetch,
        store,
        session: record,
        leaseToken: token,
        accessToken,
        source,
        totalBytes,
        // The type of the video, as the media library knows it. The chunks
        // are declared with it, so a resumed upload declares the type the
        // first upload declared: a MOV or a WebM that is resumed as an MP4
        // is refused by the provider.
        mimeType: mimeType ?? "video/mp4",
        deadlineMs,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        uploadUrl: buildYoutubeUploadUrl(
          // The settings the approved request was made with. A session that
          // was admitted but never opened a provider session is opened with
          // the SAME request: the same parts, and the same subscriber
          // notification the customer chose.
          record.uploadSettings,
        ),
        // The video resource the publish sent, kept on the session. A session
        // that was admitted but never opened a provider session is opened
        // with the same resource, so the video is the one the customer asked
        // for.
        uploadBody: record.uploadBody ?? {},
        // The live state is asked about before the provider is written to.
        effectAuthority: async () =>
          await store.effectAuthority({ sessionId: record.id, leaseToken: token }),
      });
    },

    async settleUpload(args) {
      // The settlement is fenced to the worker that still owns the session,
      // and the public row and the parent rollup are settled together. A
      // worker that lost its lease settles nothing.
      const settled = await store.settle({
        sessionId: args.sessionId,
        leaseToken: args.leaseToken,
        status: args.status,
        videoId: args.videoId ?? null,
        errorMessage: args.errorMessage ?? null,
        responseData: args.responseData ?? {},
      });
      if (!settled.settled) {
        console.error(
          `[youtube] the upload outcome was not recorded: ${settled.refused ?? "unknown"}`,
        );
      }
      return settled;
    },

    async projectReceipt(args) {
      // The receipt is projected onto the public row without a lease and
      // without the provider: the video already exists, so there is nothing
      // to send and nothing to fetch.
      return await store.projectReceipt({ sessionId: args.sessionId });
    },

    async followUps(args) {
      // The run that created the video does the follow-ups. A run that
      // inherited the receipt never reaches here, so a first comment is never
      // posted twice.
      await runYoutubeFollowUps(
        {
          videoId: args.videoId,
          accessToken: args.accessToken,
          thumbnailUrl: args.post.thumbnailUrl,
          firstComment: args.post.firstComment,
        },
        youtubeFollowUpDeps(mediaHosts),
      );
    },

    async effectAuthority(args) {
      // The live state, read under the database's own locks: the attempt, the
      // post status, the content fence, the authorised target and the media.
      return await store.effectAuthority({
        sessionId: args.sessionId,
        leaseToken: args.leaseToken,
      });
    },

    async recoverFanout(args) {
      // The closure is derived from the database and it only happens when the
      // attempt's scope is complete. A destination that never started leaves
      // an explicit terminal state behind instead.
      return await store.recoverFanout({
        sessionId: args.sessionId,
        leaseToken: args.leaseToken ?? null,
      });
    },

    now: () => Date.now(),
  };
}

/**
 * The answer the worker gives the reconciler.
 *
 * It carries a reason code and the public message, never provider text and
 * never the session URI.
 */
function youtubeContinuationResponse(result: ContinuationResult): Response {
  if (result.status === "completed") {
    return createJsonResponse({
      success: true,
      status: "completed",
      reason: result.reason,
      video_id: result.videoId ?? null,
    });
  }
  if (result.status === "pending") {
    return createJsonResponse({
      success: true,
      status: "processing",
      reason: result.reason,
      next_check_at: result.nextCheckAt ?? null,
    });
  }
  // The reason code travels with the error.
  //
  // The reconciler and the other callers match on the CODE, not on the
  // message: a lease conflict, a reconciliation requirement and a failed
  // upload are three different things, and a caller that only has the
  // sentence has to guess which one it is.
  if (result.status === "refused") {
    // Nothing was sent to the provider, so a refusal is safe to repeat: the
    // next reconciler pass looks again.
    return createJsonResponse(
      { error: youtubeUploadPublicMessage(result.reason), reason: result.reason },
      503,
    );
  }
  return createJsonResponse(
    { error: youtubeUploadPublicMessage(result.reason), reason: result.reason },
    500,
  );
}

/**
 * Carries a YouTube upload on.
 *
 * The reconciler claims the session and calls this. The dispatch carried the
 * session id and the claim token; the session URI is read here, from the
 * private table, with that token. It never appears in the response.
 *
 * The work is bounded: one session, one attempt, one lease. A receipt that
 * already exists is projected onto the public row without reading any media
 * and without calling the provider.
 */
async function handleYoutubeUploadContinuation(
  supabase: SupabaseClient,
  postId: string,
  sessionId: string,
  leaseToken: string,
  attemptStartedAt: string | null,
): Promise<Response> {
  const store = createSupabaseYoutubeUploadSessionStore(supabase);
  const mediaHosts = await approvedMediaHostSet(supabase);
  const deadlineMs = workerPublishDeadline(WORKER_STARTED_AT_MS);

  const result = await continueYoutubeUpload(
    buildYoutubeContinuationPorts(supabase, store, mediaHosts, deadlineMs),
    {
      postId,
      sessionId,
      leaseToken,
      attemptStartedAt,
    },
  );

  console.log(`[youtube] continuation ${result.status} (${result.reason})`);
  return youtubeContinuationResponse(result);
}

/**
 * Post to YouTube (video uploads, Shorts)
 *
 * The upload is native and resumable. The video is written in bounded
 * chunks, the provider's answer is asked for after every write that did not
 * answer, and the whole state of the upload is kept in a private, leased
 * session row. That is what makes a second video on the customer's channel
 * impossible: a receipt that already exists is used instead of an upload, and
 * a session that may have been accepted by the provider is left for a human
 * instead of being written again.
 */
async function postToYouTube(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  mediaFiles: MediaFile[],
  supabase: SupabaseClient,
  attemptStartedAt: string | null,
  targetAccountIds: string[],
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;

  // YouTube only supports video uploads
  const videoIndex = mediaUrls.findIndex((url) => isVideoUrl(url));
  const videoUrl = videoIndex >= 0 ? mediaUrls[videoIndex] : null;

  if (!videoUrl) {
    throw new Error("YouTube requires a video file. Please upload a video to post to YouTube.");
  }

  // The media urls are built in the same order as the media files, so the
  // video's own file is the one the durable session is fenced on.
  const videoFile = videoIndex >= 0 ? mediaFiles[videoIndex] : undefined;

  // Get YouTube settings from metadata
  const metadata = post.metadata;
  const isShort = metadata?.youtube_video_type === "short";
  let title = metadata?.youtube_title || post.caption?.substring(0, 100) || "New Video";

  // Auto-add #Shorts hashtag for Shorts if not present
  if (isShort && !title.toLowerCase().includes("#shorts")) {
    title = title.length > 90 ? title.substring(0, 90) + " #Shorts" : title + " #Shorts";
  }

  const description = metadata?.youtube_description || post.caption || "";
  const tags = metadata?.youtube_tags || [];
  const privacyStatus = metadata?.youtube_visibility || "private";

  // DEBUG: Log tags to verify they are being received correctly
  console.log(`[YouTube Debug] Raw metadata.youtube_tags:`, JSON.stringify(metadata?.youtube_tags));
  console.log(`[YouTube Debug] Processed tags array:`, JSON.stringify(tags));
  console.log(`[YouTube Debug] Tags type: ${typeof tags}, Is Array: ${Array.isArray(tags)}, Length: ${tags.length}`);

  const firstComment = metadata?.youtube_first_comment;
  const thumbnailUrl = metadata?.youtube_thumbnail_url;

  console.log(`YouTube upload - type: ${isShort ? "Short" : "Video"}, title: ${title}, privacy: ${privacyStatus}`);

  // ─────────────────────────────────────────────────────────────────────
  // The media host policy.
  //
  // The video is read over the network, so the host it is read from has to
  // be one Postora reviewed. The check runs BEFORE the first request, so an
  // unapproved host never receives one, and the source checks every redirect
  // hop again.
  // ─────────────────────────────────────────────────────────────────────
  const mediaHosts = await approvedMediaHostSet(supabase);
  const readUrl = youtubeStorageReadUrl(videoUrl);
  if (!isApprovedMediaUrl(readUrl, mediaHosts)) {
    throw new Error(youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.media_origin_not_approved));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: The video is read a chunk at a time, so only its size and its
  // type are asked for. The file itself is never held whole.
  // ─────────────────────────────────────────────────────────────────────
  const source = await createVideoByteSource({
    url: readUrl,
    mimeType: videoFile?.mime_type ?? null,
    approvedHosts: mediaHosts,
  });
  const mimeType = source.mimeType;
  const videoSize = source.size;

  console.log(`YouTube: Video ready, size=${videoSize}, mimeType=${mimeType}`);

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: The request the provider is asked to create.
  // ─────────────────────────────────────────────────────────────────────
  // The request is built by the YouTube provider adapter so the fields that
  // the YouTube Data API actually accepts are the ones that get sent.
  const uploadRequest = buildYoutubeUploadRequest({
    metadata,
    title,
    description,
    tags,
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: The durable session.
  //
  // The admission creates the private session AND the public pending row in
  // one transaction, before the provider is contacted at all. It holds the
  // provider's resumable session URI, the confirmed offset and the video id.
  // It is private to the service role, so the URI never reaches a log line, a
  // telemetry event or a client response.
  // ─────────────────────────────────────────────────────────────────────
  const store = createSupabaseYoutubeUploadSessionStore(supabase);
  const leaseToken = crypto.randomUUID();
  const publishDeadlineMs = workerPublishDeadline(WORKER_STARTED_AT_MS);
  const leaseMs = Math.max(60_000, publishDeadlineMs - Date.now() + 10_000);

  const opened = await openYoutubeUploadSession(
    store,
    {
      postId: post.id,
      socialAccountId: account.id,
      mediaFileId: videoFile?.id ?? null,
      mediaObjectVersion: videoFile?.current_object_version ?? null,
      mediaSize: videoSize,
      totalBytes: videoSize,
      uploadBody: uploadRequest.body,
      // The query settings of the request. They travel with the session, so a
      // worker that opens the provider session later makes the SAME request:
      // the same parts, and the same subscriber notification the customer
      // chose.
      uploadSettings: {
        part: uploadRequest.part,
        notifySubscribers: uploadRequest.notifySubscribers,
      },
      userId: post.user_id,
      attemptStartedAt,
      targetAccountIds,
      // The snapshot the upload body was built from. The admission compares
      // it with the live post under the post's lock, so a body that was
      // built from a stale read is refused rather than blessed.
      expectedContent: threadsImageContentFence(post),
    },
    leaseToken,
    leaseMs,
  );

  if (opened.refused || !opened.record) {
    const refusal = opened.refused ?? "post_not_found";
    // The refusal carries the uncertain marker when the channel may already
    // hold a video of this post, so the row the outer loop writes is never
    // offered as a retry that could publish a second one.
    throw uploadRefusalFailure(refusal, youtubeUploadRefusalMessage(refusal));
  }

  // The public row the upload settles when it finishes.
  const pendingPlatformPostId = opened.platformPostId;
  const uploadSessionId = opened.record.id;

  // A receipt that already exists belongs to an earlier attempt. The video
  // is not uploaded again, and the first comment is not posted again either.
  const inheritedReceipt = opened.record.videoId;

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: The upload itself.
  // ─────────────────────────────────────────────────────────────────────
  const outcome = await runResumableVideoUpload({
    fetchImpl: fetch,
    store,
    session: opened.record,
    leaseToken,
    accessToken,
    source,
    totalBytes: videoSize,
    mimeType,
    deadlineMs: publishDeadlineMs,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uploadUrl: uploadRequest.url,
    uploadBody: uploadRequest.body,
    // The live state is asked about before the provider is written to. The
    // lease says this worker owns the upload; only the live state says the
    // post, the content, the target and the media are still what this worker
    // saw.
    effectAuthority: async () =>
      await store.effectAuthority({ sessionId: uploadSessionId, leaseToken }),
  });

  // A file that is still being scanned is a WAIT, not a failure: the scan
  // finishes on its own and the upload continues afterwards. The row stays
  // pending so the continuation carries it on, and the post is not failed
  // over a file the customer has not uploaded yet.
  const waitsForTheScan =
    outcome.kind !== "completed" && outcome.reason === YOUTUBE_UPLOAD_REASON.resumable;

  if (outcome.kind === "resumable" || waitsForTheScan) {
    // The upload continues in a later worker. The row stays pending and the
    // post stays processing, so the sweeper leaves it alone and the
    // continuation finishes it.
    console.log(`YouTube upload continues later (${outcome.reason}).`);
    return { pendingContinuation: true, pendingPlatformPostId: pendingPlatformPostId ?? undefined };
  }

  if (outcome.kind !== "completed") {
    // The upload ended for good.
    //
    // The public row is settled through the fenced settlement, because only
    // the worker that still owns the upload may record the outcome. A
    // settlement that is refused, or whose answer was lost, leaves the row to
    // the upload recovery: the row exists, it belongs to this attempt, and
    // the generic writer must not record a second one beside it.
    //
    // The marker says the outcome is not a proof. History and the API retry
    // selector read it, so a video the provider may already hold is never
    // offered as a retry.
    const settlement = await settleYoutubeUpload(store, opened.record.id, leaseToken, {
      status: "failed",
      errorMessage: youtubeUploadOutcomeReason(outcome),
      responseData: youtubeUploadFailureResponseData(outcome),
    });
    //
    // A CONFIRMED settlement is the final word: the row is a failure and the
    // customer is told what it was. An UNCONFIRMED one is a pending durable
    // handoff: the row is still open, the upload recovery owns it, and the
    // error says so instead of pretending the failure was recorded.
    throw uploadOwnedFailure(
      settlement.confirmed
        ? youtubeUploadOutcomeMessage(outcome)
        : youtubeUploadUnconfirmedMessage(outcome),
      { platformPostId: pendingPlatformPostId },
    );
  }

  const videoId = outcome.videoId;

  console.log("YouTube upload complete:", videoId);

  // ─────────────────────────────────────────────────────────────────────
  // Step 5 and 6: the follow-ups.
  //
  // They belong to the run that CREATED the video. A run that inherited a
  // receipt does not repeat them: a first comment posted twice is a duplicate
  // on the customer's channel.
  // ─────────────────────────────────────────────────────────────────────
  if (!inheritedReceipt) {
    // The follow-ups are provider WRITES, so the live state is asked about
    // first: the lease says this worker owns the upload, and it says nothing
    // about the post, the target or the content being what they were. A post
    // that was edited or cancelled while the video was being written is not
    // given a thumbnail and a comment.
    //
    // The receipt does not depend on that answer. The video exists, so it is
    // settled either way.
    const followUpAuthority = await store.effectAuthority({
      sessionId: uploadSessionId,
      leaseToken,
    });
    if (followUpAuthority.authorized) {
      await runYoutubeFollowUps(
        {
          videoId,
          accessToken,
          thumbnailUrl: thumbnailUrl ?? null,
          firstComment: firstComment ?? null,
        },
        youtubeFollowUpDeps(mediaHosts),
      );
    } else {
      console.warn(
        `YouTube follow-ups skipped: ${followUpAuthority.reason ?? "not authorized"}`,
      );
    }
  } else {
    if (thumbnailUrl) console.log("YouTube thumbnail skipped: the video was uploaded by an earlier attempt");
    if (firstComment) console.log("First comment skipped: the video was uploaded by an earlier attempt");
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: Record the outcome.
  //
  // The receipt is stored and the public row is settled in one fenced step,
  // so the row and the receipt cannot disagree.
  // ─────────────────────────────────────────────────────────────────────
  const settlement = await settleYoutubeUpload(store, opened.record.id, leaseToken, {
    status: "success",
    videoId,
    responseData: {
      youtube_video_id: videoId,
      youtube_upload_source: "publish",
      ...(uploadRequest.warnings.length > 0 ? { warnings: uploadRequest.warnings } : {}),
    },
  });
  if (!settlement.confirmed) {
    // The outcome was not recorded, or its answer was lost. The row belongs to
    // this attempt, so it is handed to the upload recovery with its id: the
    // recovery settles it, and the generic writer does not write a second row
    // beside it.
    //
    // The receipt is already stored, so the recovery finds the video instead
    // of uploading it again, and the customer is never told that a retry is
    // safe when it is not.
    throw uploadOwnedFailure(youtubeUploadUnconfirmedMessage(outcome), {
      platformPostId: pendingPlatformPostId,
      videoId,
    });
  }

  return {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    pendingPlatformPostId: pendingPlatformPostId ?? undefined,
    settledByUpload: true,
    ...(uploadRequest.warnings.length > 0 ? { warnings: uploadRequest.warnings } : {}),
  };
}

