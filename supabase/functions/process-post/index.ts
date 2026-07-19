/**
 * ============================================================================
 * PROCESS-POST EDGE FUNCTION
 * ============================================================================
 * 
 * This function processes posts and publishes content to multiple social media
 * platforms. Due to Supabase Edge Function limitations, all code must be in
 * this single file - imports from other files are not supported.
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
import { validateRequestBody, validationErrorResponse } from "../_shared/validate.ts";
import { postWebhook, validateWebhookTarget } from "../_shared/webhookSecurity.ts";
import { getMissingMediaFileIds } from "../_shared/post-media.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import { z } from "npm:zod@3.23.8";

const ProcessPostSchema = z.object({
  post_id: z.string().min(1).max(100),
  platforms: z.array(z.string().max(50)).optional(),
  account_ids: z.array(z.string().max(100)).optional(),
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
interface PlatformMetadata {
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
  metadata?: PlatformMetadata | null;
}

/**
 * Social account data from social_accounts table
 */
interface SocialAccount {
  id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  access_token: string;
  refresh_token: string | null;
  account_metadata: Record<string, unknown> | null;
  ig_auth_type?: string | null;
}

/**
 * Media file data from media_files table
 */
interface MediaFile {
  id: string;
  file_path: string;
  file_type: string;
  storage_bucket: string;
  mime_type?: string | null;
}

/**
 * Result from posting to a platform
 */
interface PlatformPostResult {
  id?: string;
  url?: string;
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
}

/**
 * Aggregated result for response
 */
interface PlatformResultSummary {
  platform: string;
  status: string;
  platform_post_url?: string;
  error_message?: string;
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
  level?: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.rpc("log_system_event", {
      p_level: args.level || "warning",
      p_service: "process-post",
      p_message: args.message,
      p_details: args.details ?? {},
      p_error_code: args.errorCode,
      p_error_message: null,
      p_user_id: args.userId ?? null,
    });
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
 */
async function downloadMediaAsBlob(url: string): Promise<{
  blob: Blob;
  mimeType: string;
  size: number;
}> {
  const response = await fetch(url);
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
async function sendWebhookNotifications(
  supabase: SupabaseClient,
  userId: string,
  event: string,
  data: Record<string, unknown>,
  perRequestWebhook?: { url: string; secret?: string }
): Promise<void> {
  console.log(`Sending webhook notification: ${event} for user ${userId}`);

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
        console.warn(`Skipping unsafe per-request webhook: ${perRequestWebhook.url}`);
      } else {
        await postWebhook(perRequestWebhook.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
        console.log("Per-request webhook sent successfully");
      }
    } catch (webhookError) {
      console.error("Failed to send per-request webhook:", webhookError);
    }
  }

  try {
    // Fetch user's registered webhooks
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("value")
      .like("key", `n8n_webhook_${userId}_%`);

    if (error || !settings?.length) {
      console.log("No registered webhooks found for user:", userId);
      return;
    }

    // Send to all active webhooks that subscribe to this event
    for (const setting of settings) {
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
          console.warn(`Skipping unsafe registered webhook: ${webhook.webhook_url}`);
          continue;
        }
        console.log(`Sending to registered webhook: ${webhook.webhook_url}`);
        await postWebhook(webhook.webhook_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Postora-Event": event,
            "X-Postora-Timestamp": payload.timestamp
          },
          body: JSON.stringify(payload)
        });
      } catch (webhookError) {
        console.error("Failed to send webhook:", webhookError);
      }
    }
  } catch (error) {
    console.error("Error sending webhook notifications:", error);
  }
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
        const publiclyAvailablePostId = statusData?.data?.publicaly_available_post_id;
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

        // Update platform_posts record with success
        const { error: updateError } = await supabase
          .from("platform_posts")
          .update({
            status: "success",
            platform_post_id: publiclyAvailablePostId || publishId,
            platform_post_url: postUrl,
            posted_at: new Date().toISOString(),
          })
          .eq("id", platformPostId);

        if (updateError) {
          console.error(`[Background] Failed to update platform_posts:`, updateError);
        }

        // Check if all platforms succeeded and update post status
        const { data: allPlatformPosts } = await supabase
          .from("platform_posts")
          .select("status")
          .eq("post_id", postId);

        if (allPlatformPosts) {
          const allSuccess = allPlatformPosts.every(p => p.status === "success");
          if (allSuccess) {
            await supabase
              .from("posts")
              .update({ status: "completed", posted_at: new Date().toISOString() })
              .eq("id", postId);
          }
        }

        return;
      } else if (status === "FAILED") {
        const failReason = statusData?.data?.fail_reason || "Unknown reason";
        console.error(`[Background] TikTok publish failed:`, failReason);

        // Update platform_posts with failure
        await supabase
          .from("platform_posts")
          .update({
            status: "failed",
            error_message: `TikTok publish failed: ${failReason}`,
          })
          .eq("id", platformPostId);

        // Update post status if all failed
        await supabase
          .from("posts")
          .update({ status: "failed" })
          .eq("id", postId);

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
  platformResults: PlatformResult[]
): Promise<void> {
  try {
    console.log(`[Email] Checking if failure email should be sent for user ${userId}`);

    // Check admin-level global toggle for user post failure emails
    const { data: settingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_post_failure")
      .maybeSingle();

    if (settingRow) {
      const parsed = typeof settingRow.value === "string" ? JSON.parse(settingRow.value) : settingRow.value;
      if (parsed === false) {
        console.log("[Email] Post failure emails globally disabled by admin, skipping");
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
      console.error("[Email] Could not fetch user profile:", profileError);
      return;
    }

    // Only send if user explicitly opted in (null and false both mean disabled)
    const emailEnabled = profile?.email_notifications_enabled === true;

    if (!emailEnabled) {
      console.log("[Email] Email notifications disabled for user, skipping");
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
    const { error: invokeError } = await supabase.functions.invoke("send-subscription-email", {
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
      console.error("[Email] Failed to invoke email function:", invokeError);
    } else {
      console.log("[Email] Failure notification email sent successfully");
    }
  } catch (error) {
    console.error("[Email] Error sending failure notification:", error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: MAIN REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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
    const { post_id, platforms: overridePlatforms, account_ids: overrideAccountIds } = validation.data;

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

    // Update post status to processing
    await supabase
      .from("posts")
      .update({ status: "processing" })
      .eq("id", post_id);

    // ─────────────────────────────────────────────────────────────────────
    // Step 2: Get media files and generate URLs
    // ─────────────────────────────────────────────────────────────────────
    let mediaFiles: MediaFile[] = [];
    if (post.media_file_ids && post.media_file_ids.length > 0) {
      const { data: files } = await supabase
        .from("media_files")
        .select("*")
        .in("id", post.media_file_ids);

      mediaFiles = files || [];
      console.log("Media files:", mediaFiles.length);

      const missingMediaFileIds = getMissingMediaFileIds(post.media_file_ids, mediaFiles);
      if (missingMediaFileIds.length > 0) {
        const message = `Post media is unavailable. Re-upload all ${post.media_file_ids.length} media item(s) before retrying.`;
        console.error(message, { postId: post_id, missingMediaFileIds });
        await supabase.from("posts").update({ status: "failed" }).eq("id", post_id);
        return createErrorResponse(message, 422);
      }
    }

    // Generate URLs for media files
    const mediaUrls: string[] = [];
    for (const file of mediaFiles) {
      if (file.storage_bucket === "cloudinary") {
        // Cloudinary files: file_path contains the full URL
        console.log(`Using Cloudinary URL for ${file.id}: ${file.file_path}`);
        mediaUrls.push(file.file_path);
      } else {
        // Supabase storage: create signed URL
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from(file.storage_bucket)
          .createSignedUrl(file.file_path, 3600); // 1 hour expiry

        if (signedUrlError) {
          console.error(`Failed to create signed URL for ${file.file_path}:`, signedUrlError);
        } else if (signedUrlData?.signedUrl) {
          console.log(`Generated signed URL for ${file.file_path}`);
          mediaUrls.push(signedUrlData.signedUrl);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 3: Get social accounts for selected platforms
    // Use override values if provided (for single-platform retry), else use post data
    // ─────────────────────────────────────────────────────────────────────

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
      await supabase.from("posts").update({ status: "failed" }).eq("id", post_id);
      return createErrorResponse(msg, 400);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 3.5: JIT Token Refresh for YouTube
    // YouTube tokens expire every hour. Refresh inline before posting.
    // ─────────────────────────────────────────────────────────────────────
    const postSource = (post as any).source || 'frontend';
    console.log(`[JIT] Checking YouTube tokens for post ${post_id} (source: ${postSource}, platforms: ${post.platforms?.join(',')})`);

    for (const account of (accounts || [])) {
      if (account.platform !== 'youtube') continue;

      const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
      const now = Date.now();
      const thirtyMinMs = 30 * 60 * 1000;

      if (expiresAt - now > thirtyMinMs) continue; // Token still fresh

      console.log(`[JIT] YouTube token expiring/expired for account ${account.id}, refreshing... (source: ${postSource}, post: ${post_id})`);

      if (!account.refresh_token) {
        console.warn(`[JIT] No refresh_token for YouTube account ${account.id}, skipping refresh (source: ${postSource}, post: ${post_id})`);
        continue;
      }

      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
            client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
            refresh_token: account.refresh_token,
          }),
        });

        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

          // Update DB
          await supabase.from('social_accounts').update({
            access_token: tokenData.access_token,
            token_expires_at: newExpiresAt,
            updated_at: new Date().toISOString(),
          }).eq('id', account.id);

          // Update in-memory so postToYouTube() uses the fresh token
          (account as any).access_token = tokenData.access_token;
          (account as any).token_expires_at = newExpiresAt;

          console.log(`[JIT] YouTube token refreshed for account ${account.id}, expires: ${newExpiresAt} (source: ${postSource}, post: ${post_id})`);

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
              new_expires_at: newExpiresAt,
            },
          });
        } else {
          const errText = await tokenRes.text();
          console.error(`[JIT] YouTube token refresh failed for account ${account.id}: ${errText} (source: ${postSource}, post: ${post_id})`);

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
              error: errText,
            },
          });
        }
      } catch (refreshErr) {
        console.error(`[JIT] YouTube token refresh error for account ${account.id} (source: ${postSource}, post: ${post_id}):`, refreshErr);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 4: Post to each platform
    // ─────────────────────────────────────────────────────────────────────
    let hasSuccess = false;
    let hasFailed = false;
    const platformResults: PlatformResultSummary[] = [];

    for (const account of (accounts || [])) {
      console.log(`Posting to ${account.platform}...`);

      try {
        let result: PlatformPostResult;

        // Dispatch to platform-specific handler (alphabetical order)
        switch (account.platform) {
          case "bluesky":
            result = await postToBluesky(account, post, mediaUrls, supabase);
            break;
          case "facebook":
            result = await postToFacebook(account, post, mediaUrls, mediaFiles);
            break;
          case "instagram": {
            const igAuthType = (account as any).ig_auth_type || (account.account_metadata as Record<string, unknown>)?.account_type;
            if (igAuthType === 'business_login') {
              result = await postToInstagramBusinessLogin(account, post, mediaUrls, mediaFiles, supabase, post_id);
            } else {
              result = await postToInstagram(account, post, mediaUrls, mediaFiles);
            }
            break;
          }
          case "linkedin":
            result = await postToLinkedIn(account, post, mediaUrls);
            break;
          case "pinterest":
            result = await postToPinterest(account, post, mediaUrls, supabase);
            break;
          case "reddit":
            result = await postToReddit(account, post, mediaUrls);
            break;
          case "threads":
            result = await postToThreads(account, post, mediaUrls);
            break;
          case "tiktok":
            result = await postToTikTok(account, post, mediaUrls);
            break;
          case "twitter":
            result = await postToTwitter(account, post, mediaUrls, supabase);
            break;
          case "youtube":
            result = await postToYouTube(account, post, mediaUrls, mediaFiles);
            break;
          default:
            throw new Error(`Unsupported platform: ${account.platform}`);
        }

        // If the platform handler already wrote its own platform_posts rows
        // (e.g. Instagram fan-out into story/reel/feed), skip the default insert.
        if (result.selfWroteRows) {
          const subResults = result.subResults || [];
          for (const sub of subResults) {
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
        const { data: platformPostRecord, error: insertError } = await supabase.from("platform_posts").insert({
          post_id: post_id,
          social_account_id: account.id,
          platform: account.platform,
          platform_post_id: result.id,
          platform_post_url: result.url,
          status: resultStatus,
          posted_at: result.url ? new Date().toISOString() : null,
          response_data: {
            tiktok_publish_id: result.id,
            account_username: account.platform_username,
            account_metadata: account.account_metadata,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(locationDebug ? { location_debug: locationDebug } : {}),
            ...(topicTagDebug ? { topic_tag_debug: topicTagDebug } : {}),
          },
        }).select().single();

        if (insertError) {
          console.error(`Error inserting platform_posts record for ${account.platform}:`, insertError);
          throw new Error(`Failed to save platform post: ${insertError.message}`);
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

      } catch (error) {
        console.error(`Error posting to ${account.platform}:`, error);

        // If the handler already wrote its own rows (selfWroteRows flag on the error),
        // do not insert a duplicate failed row.
        const selfWrote = (error as { selfWroteRows?: boolean })?.selfWroteRows === true;
        if (!selfWrote) {
          await supabase.from("platform_posts").insert({
            post_id: post_id,
            social_account_id: account.id,
            platform: account.platform,
            status: "failed",
            error_message: error instanceof Error ? error.message : "Unknown error",
          });
        }

        platformResults.push({
          platform: account.platform,
          status: "failed",
          error_message: error instanceof Error ? error.message : "Unknown error",
        });

        hasFailed = true;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 5: Update post status and quotas
    // ─────────────────────────────────────────────────────────────────────
    const finalStatus = hasSuccess && !hasFailed ? "completed" : hasFailed && !hasSuccess ? "failed" : "completed";

    await supabase
      .from("posts")
      .update({
        status: finalStatus,
        posted_at: hasSuccess ? new Date().toISOString() : null
      })
      .eq("id", post_id);

    console.log("Post processing complete:", finalStatus);

    // Increment quota if at least one post was successful
    if (hasSuccess) {
      const { data: quotaData } = await supabase
        .from("user_quotas")
        .select("posts_this_month, posts_today")
        .eq("user_id", post.user_id)
        .single();

      if (quotaData) {
        await supabase
          .from("user_quotas")
          .update({
            posts_this_month: (quotaData.posts_this_month || 0) + 1,
            posts_today: (quotaData.posts_today || 0) + 1,
          })
          .eq("user_id", post.user_id);

        console.log("Quota incremented for user:", post.user_id);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 6: Send webhook notifications (non-blocking)
    // ─────────────────────────────────────────────────────────────────────
    const webhookEvent = finalStatus === "completed" ? "post.completed" : "post.failed";
    const webhookData = {
      post_id: post_id,
      caption: post.caption,
      platforms: post.platforms,
      status: finalStatus,
      platform_results: platformResults.reduce((acc, r) => {
        acc[r.platform] = {
          status: r.status,
          post_url: r.platform_post_url || null
        };
        return acc;
      }, {} as Record<string, { status: string; post_url: string | null }>)
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
            post_id: post_id,
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
        message: hasSuccess && !hasFailed
          ? `Post published successfully to ${successPlatforms.join(', ')}`
          : hasFailed && !hasSuccess
            ? `Post failed on all platforms: ${failedPlatforms.join(', ')}`
            : `Post partially succeeded: ${successPlatforms.join(', ')} succeeded, ${failedPlatforms.join(', ')} failed`,
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
        let imageBuffer: Uint8Array;

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
  const allResults: Array<{ id: string; url?: string; warnings?: string[] }> = [];

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
        level: "warning",
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
  ): Promise<{ data: Record<string, unknown>; status: number; placeAttempted: boolean }> => {
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
          level: "warning",
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
        level: "warning",
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
 * Poll Instagram container status until ready
 */
async function pollContainerStatus(
  containerId: string,
  accessToken: string,
  maxAttempts = 60, // Increased from 30 to 60 (2 min total for large video reels)
  delayMs = 2000
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchWithTimeout(
      `https://graph.facebook.com/v18.0/${containerId}?fields=status_code&access_token=${accessToken}`,
      {},
      15000,
    );
    const data = await response.json();

    console.log(`Container ${containerId} status check ${attempt + 1}:`, data.status_code);

    if (data.error) {
      throw new Error(`Container status error: ${data.error.message}`);
    }

    if (data.status_code === "FINISHED") {
      // Add a buffer delay after FINISHED to ensure Instagram's backend is truly ready
      console.log(`Container ${containerId} finished, waiting 3s before publish...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return data.status_code;
    }

    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Container failed with status: ${data.status_code}`);
    }

    // Still IN_PROGRESS, wait and retry
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Container processing timed out after polling");
}

/**
 * Publish Instagram media with retry logic for race conditions
 */
async function publishInstagramMedia(
  igUserId: string,
  creationId: string,
  accessToken: string,
  maxRetries = 5,
  initialDelayMs = 2000
): Promise<{ id: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const publishResponse = await fetchWithTimeout(
      `https://graph.facebook.com/v18.0/${igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creation_id: creationId,
          access_token: accessToken,
        }),
      },
      20000,
    );

    const publishData = await publishResponse.json();
    console.log(`Instagram publish attempt ${attempt + 1}:`, JSON.stringify(publishData).slice(0, 300));

    if (publishData.id) {
      return publishData;
    }

    if (publishData.error) {
      lastError = new Error(publishData.error.message);

      const isRetryable = 
        publishData.error.code === 9007 ||
        publishData.error.message?.includes("Media ID is not available") ||
        publishData.error.message?.includes("not ready for publishing") ||
        publishData.error.message?.includes("An unexpected error has occurred") ||
        publishData.error.message?.includes("Please retry your request") ||
        publishData.error.code === 2 ||
        publishData.error.code === 4;

      if (isRetryable) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        console.log(`Instagram publish error (retryable), attempt ${attempt + 1}, retrying in ${delayMs}ms: ${publishData.error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error("Failed to publish Instagram media after retries");
}

/**
 * Post to Instagram (feed posts, Reels, carousels)
 */
async function postToInstagram(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  mediaFiles: MediaFile[]
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
  const shareToFeed = metadata?.instagram_share_to_feed !== false; // default true
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
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${igLocationId}?fields=name,location,is_eligible_for_location_tag&access_token=${encodeURIComponent(accessToken)}`
      );
      const data = await res.json();
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
  ): Promise<Record<string, unknown>> => {
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
          level: "warning",
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

    if (publishedMediaId) {
      locationDebug.post_publish_verify_attempted = true;
      const data = await fetchJsonWithTimeout(
        `https://graph.facebook.com/v18.0/${publishedMediaId}?fields=id,caption,permalink,location&access_token=${encodeURIComponent(accessToken)}`,
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

  // Helper: disable comments on a published IG media (Page-flow / Graph API)
  const disableIgComments = async (mediaId: string) => {
    if (!disableComments) return;
    try {
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${mediaId}?comment_enabled=false&access_token=${encodeURIComponent(accessToken)}`,
        { method: "POST" }
      );
      const data = await res.json();
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
      const commentRes = await fetch(
        `https://graph.facebook.com/v18.0/${mediaId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: firstComment, access_token: accessToken }),
        }
      );
      const commentData = await commentRes.json();
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
  const publishIgStoryFromMedia = async (): Promise<void> => {
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
      const createRes = await fetch(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(storyBody) }
      );
      const createData = await createRes.json();
      if (createData.error) {
        warnings.push(`Also share to Story failed: ${createData.error.message}`);
        return;
      }
      await pollContainerStatus(createData.id, accessToken);
      await publishInstagramMedia(igUserId, createData.id, accessToken);
      console.log("Instagram 'Also share to Story' published successfully");
    } catch (e) {
      warnings.push(`Also share to Story failed: ${e instanceof Error ? e.message : "Unknown error"}`);
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

  // Handle story separately if included in post types
  const igAllResults: Array<{ id: string; url?: string; warnings?: string[] }> = [];

  if (igPostTypes.includes("story") && mediaUrls.length > 0) {
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

    console.log("Instagram Story request:", JSON.stringify(storyBody).slice(0, 500));

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
      await pollContainerStatus(createData.id, accessToken);

      // Publish the story
      const publishData = await publishInstagramMedia(igUserId, createData.id, accessToken);

      const mediaResponse = await fetch(
        `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink&access_token=${accessToken}`
      );
      const mediaData = await mediaResponse.json();

      igAllResults.push({
        id: publishData.id,
        url: mediaData.permalink || (username ? `https://www.instagram.com/${username}/` : `https://instagram.com`),
        warnings: [],
      });
    }
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

    // Poll for container status before publishing (Required for videos)
    await pollContainerStatus(createData.id, accessToken);

    // Publish the media with retry logic
    const publishData = await publishInstagramMedia(igUserId, createData.id, accessToken);

    // Post first comment
    await postInstagramFirstComment(publishData.id);
    await disableIgComments(publishData.id);

    // Get the permalink for the Reel
    const mediaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink,shortcode&access_token=${accessToken}`
    );
    const mediaData = await mediaResponse.json();

    let postUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
    if (mediaData.permalink) {
      postUrl = mediaData.permalink;
    } else if (mediaData.shortcode) {
      postUrl = `https://www.instagram.com/reel/${mediaData.shortcode}/`;
    }

    // Mirror to Story if toggle is on (and Story wasn't already in post types)
    if (shareToStory && !igPostTypes.includes("story")) {
      await publishIgStoryFromMedia();
    }

    const reelDebug = await finalizeIgLocationDebug(publishData.id);
    return {
      id: publishData.id,
      url: postUrl,
      warnings,
      ...(reelDebug ? { location_debug: reelDebug } : {}),
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

    // Poll for container status before publishing
    await pollContainerStatus(createData.id, accessToken);

    // Publish the media with retry logic
    const publishData = await publishInstagramMedia(igUserId, createData.id, accessToken);

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
      await publishIgStoryFromMedia();
    }

    const singleDebug = await finalizeIgLocationDebug(publishData.id);
    return {
      id: shortcode || publishData.id,
      url: username && shortcode
        ? `https://www.instagram.com/${username}/p/${shortcode}/`
        : mediaData.permalink || `https://instagram.com`,
      warnings,
      ...(singleDebug ? { location_debug: singleDebug } : {}),
    };

  } else {
    // ─────────────────────────────────────────────────────────────────────
    // Carousel Post (2-10 images)
    // ─────────────────────────────────────────────────────────────────────
    const containerIds: string[] = [];

    // Create item containers
    for (const url of optimizedMediaUrls.slice(0, 10)) {
      const childBody: Record<string, unknown> = {
        image_url: url,
        is_carousel_item: true,
        access_token: accessToken,
      };
      if (igAltText) childBody.alt_text = igAltText;
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(childBody),
        }
      );

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      // Poll each item container
      await pollContainerStatus(data.id, accessToken);
      containerIds.push(data.id);
    }

    // Create carousel container
    const carouselBody: Record<string, unknown> = {
      media_type: "CAROUSEL",
      children: containerIds.join(","),
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

    // Poll carousel container
    await pollContainerStatus(carouselData.id, accessToken);

    // Publish carousel with retry logic
    const publishData = await publishInstagramMedia(igUserId, carouselData.id, accessToken);

    // Post first comment
    await postInstagramFirstComment(publishData.id);
    await disableIgComments(publishData.id);

    // Get the permalink
    const mediaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${publishData.id}?fields=permalink&access_token=${accessToken}`
    );
    const mediaData = await mediaResponse.json();

    // Mirror to Story if toggle is on (and Story wasn't already in post types)
    if (shareToStory && !igPostTypes.includes("story")) {
      await publishIgStoryFromMedia();
    }

    const carouselDebug = await finalizeIgLocationDebug(publishData.id);
    return {
      id: publishData.id,
      url: mediaData.permalink || `https://instagram.com`,
      warnings,
      ...(carouselDebug ? { location_debug: carouselDebug } : {}),
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
async function pollBusinessLoginContainerStatus(
  containerId: string,
  accessToken: string,
  maxAttempts = 30,
  delayMs = 2000
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `https://graph.instagram.com/v22.0/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    const data = await response.json();

    console.log(`BL Container ${containerId} status check ${attempt + 1}:`, data.status_code);

    if (data.error) {
      throw new Error(`Container status error: ${data.error.message}`);
    }

    if (data.status_code === "FINISHED") {
      console.log(`BL Container ${containerId} finished, waiting 3s before publish...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return data.status_code;
    }

    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Container failed with status: ${data.status_code}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Container processing timed out after polling");
}

/**
 * Publish Instagram Business Login media with retry logic
 * Uses graph.instagram.com instead of graph.facebook.com
 */
async function publishBusinessLoginMedia(
  igUserId: string,
  creationId: string,
  accessToken: string,
  maxRetries = 5,
  initialDelayMs = 2000
): Promise<{ id: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const publishResponse = await fetch(
      `https://graph.instagram.com/v22.0/${igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creation_id: creationId,
          access_token: accessToken,
        }),
      }
    );

    const publishData = await publishResponse.json();
    console.log(`BL Instagram publish attempt ${attempt + 1}:`, JSON.stringify(publishData).slice(0, 300));

    if (publishData.id) {
      return publishData;
    }

    if (publishData.error) {
      lastError = new Error(publishData.error.message);

      const isRetryable = 
        publishData.error.code === 9007 ||
        publishData.error.message?.includes("Media ID is not available") ||
        publishData.error.message?.includes("not ready for publishing") ||
        publishData.error.message?.includes("An unexpected error has occurred") ||
        publishData.error.message?.includes("Please retry your request") ||
        publishData.error.code === 2 || // Temporary error
        publishData.error.code === 4; // Rate limit / too many calls

      if (isRetryable) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        console.log(`BL Instagram publish error (retryable), attempt ${attempt + 1}, retrying in ${delayMs}ms: ${publishData.error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error("Failed to publish Instagram media after retries");
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
  postId: string
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
  ): Promise<Record<string, unknown>> => {
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
          level: "warning",
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
    extraData?: Record<string, unknown>
  ): Promise<string | null> => {
    try {
      const { data, error } = await supabase.from("platform_posts").insert({
        post_id: postId,
        social_account_id: account.id,
        platform: "instagram",
        platform_post_id: mediaId || null,
        platform_post_url: postUrl || null,
        status,
        posted_at: status === "success" ? new Date().toISOString() : null,
        error_message: errorMessage || null,
        response_data: {
          ig_post_subtype: subtype,
          account_username: account.platform_username,
          account_metadata: account.account_metadata,
          ...(extraData || {}),
        },
      }).select("id").single();
      if (error) {
        console.error(`[IG ${subtype}] insert failed:`, error.message);
        return null;
      }
      console.log(`[IG ${subtype}] platform_posts row inserted: ${data.id} (status=${status})`);
      return data.id;
    } catch (e) {
      console.error(`[IG ${subtype}] insert exception:`, e);
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

  const optimizedMediaUrls = await optimizeUrlsForInstagram(mediaUrls);

  // ─── 1. STORY ──────────────────────────────────────────────────────────────
  const wantStory = blPostTypes.includes("story") || (shareToStory && mediaUrls.length > 0);
  if (wantStory) {
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
        await pollBusinessLoginContainerStatus(createData.id, accessToken);
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

  if (mediaType === "VIDEO" && (wantReel || wantFeed)) {
    // Meta API: standalone feed videos must be posted as Reels.
    // If user picked "feed" alone, publish as Reel and warn.
    // If user picked both feed+reel, publish ONE Reel with share_to_feed=true (mirrors to feed).
    if (wantFeed && !wantReel) {
      warnings.push("Instagram feed-video posts are published as Reels (Meta API requirement) and mirrored to your feed.");
    }
    try {
      const reelsBody: Record<string, unknown> = {
        media_type: "REELS",
        video_url: mediaUrls[0],
        caption: post.caption,
        share_to_feed: wantFeed, // mirror to feed when "feed" was selected
        access_token: accessToken,
      };
      if (coverThumbnailOffset > 0) reelsBody.thumb_offset = coverThumbnailOffset;
      if (audioName) reelsBody.audio_name = audioName;
      if (collaborator) {
        const cleanCollaborator = collaborator.replace("@", "").trim();
        if (cleanCollaborator) reelsBody.collaborators = [cleanCollaborator];
      }
      if (await checkBLLocationEligibility()) reelsBody.location_id = instagramLocationId;

      let createData = await blMediaCreateWithLocationRetry(
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
        await pollBusinessLoginContainerStatus(createData.id, accessToken);
        const publishData = await publishBusinessLoginMedia(igUserId, createData.id, accessToken);
        const fallbackUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
        const subtype = wantReel ? "reel" : "feed";
        const blDebug = await finalizeBLLocationDebug(publishData.id);
        const rowId = await insertIGRow(subtype, "success", publishData.id, fallbackUrl, undefined, {
          shared_to_feed: wantFeed,
          ...(blDebug ? { location_debug: blDebug } : {}),
        });
        subResults.push({ subtype, status: "success", id: publishData.id, url: fallbackUrl });
        enrichInBackground(rowId, publishData.id, subtype, fallbackUrl);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const subtype = wantReel ? "reel" : "feed";
      await insertIGRow(subtype, "failed", undefined, undefined, msg);
      subResults.push({ subtype, status: "failed", error: msg });
    }
  }

  // ─── 3. FEED IMAGE / CAROUSEL ──────────────────────────────────────────────
  if (mediaType === "IMAGE" && wantFeed) {
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
          await pollBusinessLoginContainerStatus(createData.id, accessToken);
          const publishData = await publishBusinessLoginMedia(igUserId, createData.id, accessToken);
          const fallbackUrl = username ? `https://www.instagram.com/${username}/` : `https://instagram.com`;
          const blDebug = await finalizeBLLocationDebug(publishData.id);
          const rowId = await insertIGRow("feed", "success", publishData.id, fallbackUrl, undefined, blDebug ? { location_debug: blDebug } : undefined);
          subResults.push({ subtype: "feed", status: "success", id: publishData.id, url: fallbackUrl });
          enrichInBackground(rowId, publishData.id, "feed", fallbackUrl);
        }
      } else {
        // Carousel
        const containerIds: string[] = [];
        for (const url of optimizedMediaUrls.slice(0, 10)) {
          const childBody: Record<string, unknown> = {
            image_url: url,
            is_carousel_item: true,
            access_token: accessToken,
          };
          if (igAltText) childBody.alt_text = igAltText;
          const response = await fetch(
            `https://graph.instagram.com/v22.0/${igUserId}/media`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(childBody) }
          );
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          await pollBusinessLoginContainerStatus(data.id, accessToken);
          containerIds.push(data.id);
        }

        const carouselBody: Record<string, unknown> = {
          media_type: "CAROUSEL",
          children: containerIds.join(","),
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

        await pollBusinessLoginContainerStatus(carouselData.id, accessToken);
        const publishData = await publishBusinessLoginMedia(igUserId, carouselData.id, accessToken);
        const fallbackUrl = `https://instagram.com`;
        const blDebug = await finalizeBLLocationDebug(publishData.id);
        const rowId = await insertIGRow("feed", "success", publishData.id, fallbackUrl, undefined, blDebug ? { location_debug: blDebug } : undefined);
        subResults.push({ subtype: "feed", status: "success", id: publishData.id, url: fallbackUrl });
        enrichInBackground(rowId, publishData.id, "feed", fallbackUrl);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await insertIGRow("feed", "failed", undefined, undefined, msg);
      subResults.push({ subtype: "feed", status: "failed", error: msg });
    }
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────
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
  const rawDestinations = Array.isArray(metadata?.linkedin_destination_ids)
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
  supabase: SupabaseClient
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
  let specifiedBoardId = nestedBoardId ?? metadata?.pinterest_board_id;

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

  // Stamp pinterest_post_type onto the post's metadata so /history can render the badge
  const stampPinterestType = async () => {
    try {
      const newMetadata = { ...(metadata || {}), pinterest_post_type: resolvedPinType };
      await supabase.from("posts").update({ metadata: newMetadata }).eq("id", post.id);
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
  mediaUrls: string[]
): Promise<PlatformPostResult> {
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
  const preSkippedReason: string | undefined = metadata?.threads_location_skipped_reason;
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
  if (mediaUrls.length > 0) {
    // Threads has an 8MB per-image hard limit and rejects the whole carousel
    // (error 4279004 "Invalid carousel children") if any single child exceeds
    // it. Cloudinary URLs can be compressed on-the-fly to JPEG q_80 which
    // typically reduces PNGs by ~95% with no visible quality loss.
    const safeMediaUrls = compressMediaUrlsForPlatform(mediaUrls);
    const firstMediaUrl = safeMediaUrls[0];
    const isVideo = isVideoUrl(firstMediaUrl);

    if (mediaUrls.length === 1) {
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
      const childIds: string[] = [];

      for (const mediaUrl of safeMediaUrls.slice(0, 10)) {
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

        const childResponse = await fetch(childUrl.toString(), { method: "POST" });
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
          continue;
        }

        childIds.push(childData.id);
      }

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

  console.log("Threads: Creating container...");

  // Create the container
  const containerUrl = new URL(containerEndpoint);
  Object.entries(containerParams).forEach(([key, value]) => {
    containerUrl.searchParams.set(key, value);
  });

  const containerResponse = await fetch(containerUrl.toString(), {
    method: "POST",
  });
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
      const retryResponse = await fetch(retryUrl.toString(), { method: "POST" });
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

  const containerId = containerData.id;

  // Poll container status until FINISHED (required by Threads API)
  const statusEndpoint = `https://graph.threads.net/v1.0/${containerId}?fields=status&access_token=${accessToken}`;
  const maxAttempts = 15;
  const pollInterval = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    
    try {
      const statusResponse = await fetch(statusEndpoint);
      const statusData = await statusResponse.json();
      const status = statusData?.status;
      
      console.log(`Threads: Container status check ${attempt}/${maxAttempts}: ${status}`);
      
      if (status === "FINISHED") {
        break;
      } else if (status === "ERROR") {
        throw new Error(`Threads container processing failed: ${JSON.stringify(statusData)}`);
      }
      
      if (attempt === maxAttempts) {
        console.warn("Threads: Container did not reach FINISHED status after max attempts, attempting publish anyway...");
      }
    } catch (statusErr) {
      console.warn(`Threads: Status check ${attempt} failed:`, statusErr);
      if (attempt === maxAttempts) break;
    }
  }

  // Publish the container
  console.log("Threads: Publishing container...");

  const publishUrl = new URL(publishEndpoint);
  publishUrl.searchParams.set("access_token", accessToken);
  publishUrl.searchParams.set("creation_id", containerId);

  const publishResponse = await fetch(publishUrl.toString(), {
    method: "POST",
  });
  const publishData = await publishResponse.json();

  console.log("Threads: Publish response:", JSON.stringify(publishData).slice(0, 200));

  if (publishData.error) {
    tLocationDebug.publish_success = false;
    tLocationDebug.publish_error = redactMetaError(publishData.error);
    throw new Error(`Threads publish error: ${publishData.error.message}`);
  }
  tLocationDebug.publish_success = true;

  const postId = publishData.id;

  // Fetch permalink + verification fields. Helps us confirm what Meta actually
  // accepted (location_id, is_quote_post, shortcode) — surfaces silent ignores.
  let postUrl = username ? `https://www.threads.com/@${username}` : undefined;
  let verifyData: any = null;
  let crossShareStatus: string | null = null;
  try {
    const verifyRes = await fetch(
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
  if (rawFirstComment && postId) {
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
      const replyContainerRes = await fetch(replyContainerUrl.toString(), { method: "POST" });
      const replyContainerData = await replyContainerRes.json().catch(() => ({}));

      if (replyContainerData?.error) {
        throw new Error(replyContainerData.error.message || "first-comment container failed");
      }
      const replyContainerId = replyContainerData?.id;
      if (!replyContainerId) throw new Error("No first-comment container id returned");

      // Poll status briefly
      const replyStatusUrl = `https://graph.threads.net/v1.0/${replyContainerId}?fields=status&access_token=${accessToken}`;
      for (let attempt = 1; attempt <= 8; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const sr = await fetch(replyStatusUrl);
          const sd = await sr.json().catch(() => ({}));
          if (sd?.status === "FINISHED") break;
          if (sd?.status === "ERROR") throw new Error("first-comment processing ERROR");
        } catch { /* keep polling */ }
      }

      const replyPublishUrl = new URL(publishEndpoint);
      replyPublishUrl.searchParams.set("access_token", accessToken);
      replyPublishUrl.searchParams.set("creation_id", replyContainerId);
      const replyPublishRes = await fetch(replyPublishUrl.toString(), { method: "POST" });
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
  mediaUrls: string[]
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;
  const metadata = post.metadata;

  console.log(`TikTok posting - mediaUrls received:`, mediaUrls);

  // ─────────────────────────────────────────────────────────────────────
  // Pre-flight check: Query creator_info to verify account privacy settings
  // ─────────────────────────────────────────────────────────────────────
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

  const postInfo: Record<string, unknown> = {
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
      const publiclyAvailablePostId = statusData?.data?.publicaly_available_post_id;
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
 * Post to YouTube (video uploads, Shorts)
 */
async function postToYouTube(
  account: SocialAccount,
  post: PostData,
  mediaUrls: string[],
  mediaFiles: MediaFile[]
): Promise<PlatformPostResult> {
  const accessToken = account.access_token;

  // YouTube only supports video uploads
  const videoUrl = mediaUrls.find((url) => isVideoUrl(url));

  if (!videoUrl) {
    throw new Error("YouTube requires a video file. Please upload a video to post to YouTube.");
  }

  // Get YouTube settings from metadata
  const metadata = post.metadata;
  const isShort = metadata?.youtube_video_type === "short";
  let title = metadata?.youtube_title || post.caption?.substring(0, 100) || "New Video";

  // Auto-add #Shorts hashtag for Shorts if not present
  if (isShort && !title.toLowerCase().includes("#shorts")) {
    title = title.length > 90 ? title.substring(0, 90) + " #Shorts" : title + " #Shorts";
  }

  const description = metadata?.youtube_description || post.caption || "";
  const privacyStatus = metadata?.youtube_visibility || "private";
  const tags = metadata?.youtube_tags || [];

  // DEBUG: Log tags to verify they are being received correctly
  console.log(`[YouTube Debug] Raw metadata.youtube_tags:`, JSON.stringify(metadata?.youtube_tags));
  console.log(`[YouTube Debug] Processed tags array:`, JSON.stringify(tags));
  console.log(`[YouTube Debug] Tags type: ${typeof tags}, Is Array: ${Array.isArray(tags)}, Length: ${tags.length}`);

  const categoryId = metadata?.youtube_category || "22"; // People & Blogs
  const madeForKids = metadata?.youtube_made_for_kids ?? false;
  const embeddable = metadata?.youtube_allow_embedding ?? true;
  const publicStatsViewable = metadata?.youtube_public_stats_viewable ?? true;
  const containsSyntheticMedia = metadata?.youtube_contains_synthetic_media ?? false;
  const hasPaidPromotion = metadata?.youtube_has_paid_promotion ?? false;
  const notifySubscribers = metadata?.youtube_notify_subscribers ?? true;
  const defaultLanguage = metadata?.youtube_video_language || undefined;
  const defaultAudioLanguage = metadata?.youtube_audio_language || undefined;
  const recordingDate = metadata?.youtube_recording_date || undefined;
  const license = metadata?.youtube_license === "creativeCommon" ? "creativeCommon" : "youtube";
  const allowedCountries = metadata?.youtube_allowed_countries || undefined;
  const blockedCountries = metadata?.youtube_blocked_countries || undefined;
  const firstComment = metadata?.youtube_first_comment;
  const thumbnailUrl = metadata?.youtube_thumbnail_url;

  console.log(`YouTube upload - type: ${isShort ? "Short" : "Video"}, title: ${title}, privacy: ${privacyStatus}`);

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: Download the video file
  // ─────────────────────────────────────────────────────────────────────
  console.log("Downloading video from:", videoUrl);
  const { blob: videoBlob, mimeType, size: videoSize } = await downloadMediaAsBlob(videoUrl);

  console.log(`YouTube: Video downloaded, size=${videoSize}, mimeType=${mimeType}`);

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Initialize resumable upload
  // ─────────────────────────────────────────────────────────────────────
  const videoMetadata: Record<string, unknown> = {
    snippet: {
      title: title.substring(0, 100),
      description: description.substring(0, 5000),
      tags: tags.slice(0, 500),
      categoryId: categoryId,
    },
    status: {
      privacyStatus: privacyStatus,
      embeddable: embeddable,
      publicStatsViewable: publicStatsViewable,
      madeForKids: madeForKids,
      selfDeclaredMadeForKids: madeForKids,
      license: license,
    },
  };

  // Add default language if specified
  if (defaultLanguage) {
    (videoMetadata.snippet as Record<string, unknown>).defaultLanguage = defaultLanguage;
  }

  if (defaultAudioLanguage) {
    (videoMetadata.snippet as Record<string, unknown>).defaultAudioLanguage = defaultAudioLanguage;
  }

  // Add recording details if specified
  if (recordingDate) {
    videoMetadata.recordingDetails = {
      recordingDate: recordingDate,
    };
  }

  // Add content details for country restrictions
  if (allowedCountries || blockedCountries) {
    const regionRestriction: Record<string, unknown> = {};
    if (allowedCountries && allowedCountries.length > 0) {
      regionRestriction.allowed = allowedCountries;
    }
    if (blockedCountries && blockedCountries.length > 0) {
      regionRestriction.blocked = blockedCountries;
    }
    videoMetadata.contentDetails = {
      regionRestriction,
    };
  }

  console.log("YouTube: Initializing resumable upload...");

  const initResponse = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,recordingDetails,contentDetails${notifySubscribers ? "" : "&notifySubscribers=false"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(videoSize),
        "X-Upload-Content-Type": mimeType,
      },
      body: JSON.stringify(videoMetadata),
    }
  );

  if (!initResponse.ok) {
    const errorData = await initResponse.json().catch(() => ({}));
    console.error("YouTube init error:", errorData);

    if (initResponse.status === 401) {
      throw new Error("YouTube authentication expired. Please reconnect your YouTube account.");
    }
    if (initResponse.status === 403) {
      const reason = errorData?.error?.errors?.[0]?.reason;
      if (reason === "quotaExceeded") {
        throw new Error("YouTube API quota exceeded. Please try again tomorrow.");
      }
      if (reason === "forbidden") {
        throw new Error("YouTube upload permission denied. Make sure your account has upload access.");
      }
      throw new Error(`YouTube permission error: ${errorData?.error?.message || "Access denied"}`);
    }
    throw new Error(`YouTube API error: ${errorData?.error?.message || initResponse.statusText}`);
  }

  const uploadUrl = initResponse.headers.get("Location");
  if (!uploadUrl) {
    throw new Error("YouTube did not return an upload URL");
  }

  console.log("Got resumable upload URL, uploading video...");

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: Upload the video content
  // ─────────────────────────────────────────────────────────────────────
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(videoSize),
    },
    body: videoBlob,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    console.error("YouTube upload error:", errorData);
    throw new Error(`YouTube upload failed: ${errorData?.error?.message || uploadResponse.statusText}`);
  }

  const uploadData = await uploadResponse.json();
  console.log("YouTube upload complete:", uploadData.id);

  const videoId = uploadData.id as string;

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: Set thumbnail if provided
  // ─────────────────────────────────────────────────────────────────────
  if (thumbnailUrl) {
    try {
      console.log("Downloading thumbnail from:", thumbnailUrl);
      const { blob: thumbBlob, mimeType: thumbMimeType } = await downloadMediaAsBlob(thumbnailUrl);

      const thumbUploadResponse = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": thumbMimeType,
          },
          body: thumbBlob,
        }
      );

      if (thumbUploadResponse.ok) {
        console.log("YouTube thumbnail set successfully");
      } else {
        console.warn("Failed to set YouTube thumbnail:", await thumbUploadResponse.text());
      }
    } catch (thumbError) {
      console.warn("Error setting YouTube thumbnail:", thumbError);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 5: Post first comment if provided
  // ─────────────────────────────────────────────────────────────────────
  if (firstComment) {
    try {
      console.log("Posting first comment to YouTube video...");
      const commentResponse = await fetch(
        "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            snippet: {
              videoId,
              topLevelComment: {
                snippet: {
                  textOriginal: firstComment,
                },
              },
            },
          }),
        }
      );

      if (commentResponse.ok) {
        console.log("First comment posted successfully");
      } else {
        console.warn("Failed to post first comment:", await commentResponse.text());
      }
    } catch (commentError) {
      console.warn("Error posting first comment:", commentError);
    }
  }

  return {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

