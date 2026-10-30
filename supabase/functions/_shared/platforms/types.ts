/**
 * Shared types for platform handlers
 * These types are used across all platform posting functions
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

/**
 * Result returned by platform posting functions
 */
export interface PlatformPostResult {
  id: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Base post data structure passed to platform handlers
 */
export interface BasePostData {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
  metadata: PlatformMetadata | null;
  media_file_ids: string[] | null;
}

/**
 * Social account data for posting
 */
export interface SocialAccountData {
  id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  access_token: string;
  refresh_token: string | null;
  account_metadata: Record<string, unknown> | null;
}

/**
 * Media file data for posting
 */
export interface MediaFileData {
  id: string;
  file_path: string;
  file_type: string;
  mime_type: string | null;
  publicUrl: string;
}

/**
 * Platform-specific metadata stored in posts.metadata
 * Each platform has its own settings that control how content is published
 */
export interface PlatformMetadata {
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
  instagram_alt_text?: string | null;
  instagram_location_id?: string | null;
  instagram_hide_like_counts?: boolean;
  instagram_disable_comments?: boolean;

  // ─────────────────────────────────────────────────────────────────────────
  // LINKEDIN
  // ─────────────────────────────────────────────────────────────────────────
  linkedin_visibility?: "public" | "connections" | null;
  linkedin_first_comment?: string | null;
  linkedin_article_link?: string | null;

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
  threads_cross_share_to_ig?: boolean;
  threads_cross_share_to_ig_dark_mode?: boolean;
  threads_first_comment?: string | null;
  /** Set by the browser when it dropped the location before sending (see usePlatformSettings). */
  threads_location_skipped_reason?: string | null;
  threads_topic_tag?: string | null;

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

  // ─────────────────────────────────────────────────────────────────────────
  // YOUTUBE
  // ─────────────────────────────────────────────────────────────────────────
  youtube_title?: string | null;
  youtube_description?: string | null;
  youtube_privacy_status?: "private" | "public" | "unlisted" | null;
  youtube_category?: string | null;
  youtube_tags?: string[] | null;
  youtube_made_for_kids?: boolean | null;
  youtube_self_declared_for_kids?: boolean | null;
  youtube_scheduled_start_time?: string | null;
  youtube_notify_subscribers?: boolean;
  youtube_default_language?: string | null;
  youtube_thumbnail_url?: string | null;
  youtube_license?: "youtube" | "creativeCommon" | null;
  youtube_allow_embedding?: boolean;
  youtube_shorts?: boolean;
  youtube_comments_moderation?: "none" | "moderate" | "hold_all" | null;
  youtube_sort_order?: "newest" | "top" | null;
}

/**
 * Context passed to platform handlers
 */
export interface PlatformPostContext {
  supabase: SupabaseClient;
  post: BasePostData;
  account: SocialAccountData;
  mediaUrls: string[];
  userId: string;
}
