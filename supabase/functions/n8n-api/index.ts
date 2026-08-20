import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sanitizeErrorMessage, sanitizeErrorDetails, getSafeErrorResponse } from "../_shared/errorSanitizer.ts";
import { postWebhook, validateWebhookTarget } from "../_shared/webhookSecurity.ts";
import {
  type LinkedInDestinationSelection,
  listLinkedInDestinations,
  normalizeLinkedInDestinationSelections,
} from "../_shared/linkedinDestinations.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

// Rate limiting configuration
const RATE_LIMITS: Record<string, { requests: number; windowMs: number }> = {
  '/api/v1/post': { requests: 30, windowMs: 60 * 60 * 1000 }, // 30 posts per hour
  '/api/v1/upload-media': { requests: 60, windowMs: 60 * 60 * 1000 }, // 60 uploads per hour
  '/api/v1/posts': { requests: 100, windowMs: 60 * 60 * 1000 }, // 100 queries per hour
  '/api/v1/accounts': { requests: 100, windowMs: 60 * 60 * 1000 }, // 100 queries per hour
  '/api/v1/webhooks': { requests: 30, windowMs: 60 * 60 * 1000 }, // 30 webhook operations per hour
  'default': { requests: 100, windowMs: 60 * 60 * 1000 }, // Default: 100 requests per hour
};

// Check rate limit using api_logs table
async function checkRateLimit(
  supabase: any,
  userId: string,
  endpoint: string,
  method: string,
  ipAddress: string | null
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const config = RATE_LIMITS[endpoint] || RATE_LIMITS['default'];
  const windowStart = new Date(Date.now() - config.windowMs);

  // Count recent requests for this user and endpoint
  const { count, error } = await supabase
    .from('api_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .gte('created_at', windowStart.toISOString());

  if (error) {
    console.error('Error checking rate limit:', error);
    // If we can't check rate limit, allow the request but log it
    return { allowed: true, remaining: config.requests, resetAt: new Date(Date.now() + config.windowMs) };
  }

  const currentCount = count || 0;
  const remaining = Math.max(0, config.requests - currentCount);
  const allowed = currentCount < config.requests;

  // Log this request
  await supabase.from('api_logs').insert({
    user_id: userId,
    endpoint: endpoint,
    method: method,
    ip_address: ipAddress,
    status_code: allowed ? 200 : 429,
  });

  return {
    allowed,
    remaining,
    resetAt: new Date(windowStart.getTime() + config.windowMs)
  };
}

// Authenticate user via API key from profiles table
async function authenticateApiKey(supabase: any, apiKey: string | null): Promise<{ userId: string; preferredTimezone: string | null } | null> {
  if (!apiKey) {
    console.log('No API key provided');
    return null;
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, preferred_timezone')
    .eq('api_key', apiKey)
    .maybeSingle();

  if (error) {
    console.error('Error validating API key:', error);
    return null;
  }

  if (!profile) {
    console.log('Invalid API key');
    return null;
  }

  console.log('API key authenticated for user:', profile.id, 'preferred_timezone:', profile.preferred_timezone);
  return { userId: profile.id, preferredTimezone: profile.preferred_timezone || null };
}

// Platform-specific metadata interface
interface PlatformMetadata {
  // YouTube
  youtube_privacy?: 'private' | 'unlisted' | 'public';
  youtube_title?: string;
  youtube_description?: string;
  youtube_tags?: string[];
  youtube_category?: string;
  youtube_made_for_kids?: boolean;
  youtube_allow_embedding?: boolean;
  youtube_public_stats_viewable?: boolean;
  youtube_contains_synthetic_media?: boolean;
  youtube_has_paid_product_placement?: boolean;
  youtube_notify_subscribers?: boolean;
  youtube_default_language?: string;
  youtube_default_audio_language?: string;
  youtube_license?: 'youtube' | 'creativeCommon';
  youtube_allowed_countries?: string[];
  youtube_blocked_countries?: string[];
  youtube_first_comment?: string;
  youtube_thumbnail?: string;
  youtube_recording_date?: string;

  // TikTok
  tiktok_post_mode?: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  tiktok_allow_comments?: boolean;
  tiktok_allow_duet?: boolean;
  tiktok_allow_stitch?: boolean;
  tiktok_disclosure_content?: boolean;
  tiktok_brand_content?: boolean;

  // Instagram - ENHANCED
  instagram_media_type?: 'feed' | 'stories' | ('feed' | 'stories')[];
  instagram_collaborators?: string[];
  instagram_user_tags?: string[];
  instagram_location_id?: string;
  instagram_title?: string;
  instagram_alt_text?: string;
  instagram_first_comment?: string;
  instagram_audio_name?: string;
  instagram_share_to_feed?: boolean;

  // Facebook
  facebook_page_id?: string;
  facebook_media_type?: 'REELS' | 'STORIES' | ('REELS' | 'STORIES')[];

  // Pinterest
  pinterest_board_id?: string;
  pinterest_title?: string;
  pinterest_link?: string;
  pinterest_alt_text?: string;

  // LinkedIn
  linkedin_page_id?: string;
  linkedin_article_url?: string;
  linkedin_destinations?: LinkedInDestinationSelection[];

  // Twitter/X - Complete settings
  twitter_reply_to_tweet_id?: string;
  twitter_quote_tweet_id?: string;
  twitter_reply_settings?: 'everyone' | 'following' | 'mentionedUsers' | 'subscribers' | 'verified';
  twitter_for_super_followers_only?: boolean;
  twitter_share_with_followers?: boolean;
  twitter_tagged_user_ids?: string[];
  twitter_exclude_reply_user_ids?: string[];
  twitter_place_id?: string;
  twitter_community_id?: string;
  twitter_dm_deep_link?: string;
  twitter_nullcast?: boolean;
  twitter_thumbnail_url?: string;
  twitter_custom_title?: string;
  twitter_thread_mode?: boolean;
  twitter_post_as_long_tweet?: boolean;
  twitter_poll_enabled?: boolean;
  twitter_poll_options?: string[];
  twitter_poll_duration?: number;
}

// Operation types matching n8n node
type OperationType = 'upload_photos' | 'upload_video' | 'upload_text' | 'upload_document';

// Helper function to upload media via keys through cloudinary-upload function
async function uploadToCloudinary(supabase: any, userId: string, payload: any): Promise<any> {
  console.log('Delegating upload to cloudinary-upload function...');

  const { data: result, error } = await supabase.functions.invoke('cloudinary-upload', {
    body: {
      ...payload,
      userId, // Pass userId so cloudinary-upload can use it when called with service role key
    }
  });

  if (error) {
    // The relay error is generic — extract actual error from result body if available
    const detail = result?.error || error.message || 'Unknown upload error';
    throw new Error(`Media upload failed: ${detail}`);
  }

  if (!result?.success) {
    throw new Error(result?.error || 'Media upload failed');
  }

  // Fetch the full media file record that was created by cloudinary-upload
  const { data: mediaFile, error: dbError } = await supabase
    .from('media_files')
    .select('*')
    .eq('id', result.mediaFileId)
    .single();

  if (dbError) {
    throw new Error(`Failed to fetch created media record: ${dbError.message}`);
  }

  return { ...mediaFile, public_url: result.url };
}

// Helper function to download and upload media from URL
async function downloadAndUploadMedia(supabase: any, userId: string, mediaUrl: string): Promise<{ id: string; error?: string }> {
  console.log('Processing media from URL:', mediaUrl);

  try {
    // Preflight: verify URL is accessible before sending to Cloudinary
    try {
      const headResp = await fetch(mediaUrl, { method: 'HEAD', redirect: 'follow' });
      if (!headResp.ok) {
        // Some servers don't support HEAD — try GET as fallback
        const getResp = await fetch(mediaUrl, { method: 'GET', redirect: 'follow' });
        if (!getResp.ok) {
          return { id: '', error: `URL not accessible (HTTP ${getResp.status}). Ensure it is a direct, public link to a media file.` };
        }
        // Consume and discard body to free resources
        await getResp.arrayBuffer();
      }
    } catch (fetchErr: any) {
      return { id: '', error: `Cannot reach URL: ${mediaUrl.substring(0, 100)} — ${fetchErr.message || 'network error'}` };
    }

    // Determine file details - simple check
    const urlPath = new URL(mediaUrl).pathname;
    let fileExt = urlPath.split('.').pop()?.split('?')[0] || 'bin';
    const fileName = `${userId}/${crypto.randomUUID()}.${fileExt}`;

    // We assume image unless extension suggests video, cloudinary-upload will detect actual type
    const isVideo = fileExt.match(/(mp4|mov|webm|avi|mpeg)/i);
    const fileType = isVideo ? 'video' : 'image';

    // Delegate to cloudinary-upload
    const mediaFile = await uploadToCloudinary(supabase, userId, {
      externalUrl: mediaUrl,
      fileName,
      fileType,
      platforms: [], // Will be updated by the main flow if needed
      socialAccountIds: []
    });

    console.log('Media uploaded successfully via Cloudinary:', mediaFile.id);
    return { id: mediaFile.id };
  } catch (error: any) {
    console.error('Error in downloadAndUploadMedia:', error);
    // Preserve the actual error message instead of sanitizing it away
    const errorMsg = error?.message || 'Unknown upload error';
    return { id: '', error: errorMsg };
  }
}

// Helper function to upload a single file from URL
async function uploadFileFromUrl(supabase: any, userId: string, mediaUrl: string): Promise<any> {
  console.log('Uploading file from URL via Cloudinary:', mediaUrl);

  // Basic validation using HEAD check could remain here if desired, 
  // but we'll let Cloudinary handle the heavy lifting to ensure consistency.

  // Determine file details
  const urlPath = new URL(mediaUrl).pathname;
  let fileExt = urlPath.split('.').pop()?.split('?')[0] || 'bin';
  const fileName = `${userId}/${crypto.randomUUID()}.${fileExt}`;

  const isVideo = fileExt.match(/(mp4|mov|webm|avi|mpeg)/i);
  const fileType = isVideo ? 'video' : 'image';

  // Delegate to cloudinary-upload
  return await uploadToCloudinary(supabase, userId, {
    externalUrl: mediaUrl,
    fileName,
    fileType
  });
}

// Helper function to upload a single file from base64 data
async function uploadFileFromBase64(supabase: any, userId: string, fileData: string, fileName?: string): Promise<any> {
  console.log('Uploading file from base64 data via Cloudinary');

  // Parse data URL to get type
  const matches = fileData.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid base64 data format. Expected: data:mime/type;base64,DATA');
  }

  const contentType = matches[1];

  const isVideo = contentType.startsWith('video/');
  const fileType = isVideo ? 'video' : 'image';

  // Generate filename if not provided
  if (!fileName) {
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/mpeg': 'mpeg', 'video/x-msvideo': 'avi'
    };
    const ext = extMap[contentType] || 'bin';
    fileName = `${crypto.randomUUID()}.${ext}`;
  }

  // Delegate to cloudinary-upload
  return await uploadToCloudinary(supabase, userId, {
    fileData,
    fileName,
    fileType
  });
}

// Helper function to parse array fields from various formats (JSON string, comma-separated, actual array)
function parseArrayField(value: any, fieldName: string): string[] {
  if (!value) return [];

  // Already an array
  if (Array.isArray(value)) {
    console.log(`${fieldName}: Already an array with ${value.length} items`);
    return value.map(v => String(v).trim()).filter(v => v);
  }

  // String value - could be JSON array, comma-separated, or single value
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    // Try to parse as JSON array (e.g., '["instagram", "facebook"]')
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          console.log(`${fieldName}: Parsed JSON array string into ${parsed.length} items`);
          return parsed.map((v: any) => String(v).trim()).filter((v: string) => v);
        }
      } catch (e) {
        console.log(`${fieldName}: Failed to parse as JSON array, trying other formats`);
      }
    }

    // Check for comma-separated values (e.g., "instagram,facebook" or "instagram, facebook")
    // Only split on comma if it's not a single value containing a comma (like a URL with query params)
    if (trimmed.includes(',') && !trimmed.includes('http://') && !trimmed.includes('https://')) {
      const parts = trimmed.split(',').map(v => v.trim()).filter(v => v);
      if (parts.length > 1) {
        console.log(`${fieldName}: Split comma-separated into ${parts.length} items`);
        return parts;
      }
    }

    // Single value
    console.log(`${fieldName}: Single value`);
    return [trimmed];
  }

  // Fallback for other types
  console.log(`${fieldName}: Converting from type ${typeof value}`);
  return [String(value)];
}

// Handle POST /api/v1/post - Create a new post with platform-specific metadata
async function handleCreatePost(req: Request, supabase: any, userId: string, body: any, userPreferredTimezone?: string | null) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Creating post for user:', userId, 'with body:', JSON.stringify(body, null, 2));

  const {
    // Core fields
    caption,
    title, // Title/Main Content - acts as caption fallback for video platforms
    platforms: rawPlatforms,
    media_file_ids,
    media_url, // Single media URL (alternative to media_urls)
    media_urls, // Direct media URLs (single URL string or array of URLs)
    media_base64, // Base64 encoded media data

    // Scheduling
    scheduled_at,
    scheduled_date, // Alternative field name for scheduled_at
    timezone,

    // Async options
    upload_async,
    wait_for_completion,
    poll_interval,
    timeout,

    // Operation type (upload_photos, upload_video, upload_text, upload_document)
    operation,

    // Account selection - ONLY two accepted field names
    account_ids: providedAccountIds,
    ACCOUNT_IDS: capitalAccountIds,
    user_identifier, // Alternative field for account selection by username

    // YouTube metadata
    youtube_privacy,
    youtube_title,
    youtube_description,
    youtube_tags,
    youtube_category,
    youtube_made_for_kids,
    youtube_allow_embedding,
    youtube_public_stats_viewable,
    youtube_contains_synthetic_media,
    youtube_has_paid_product_placement,
    youtube_notify_subscribers,
    youtube_default_language,
    youtube_default_audio_language,
    youtube_license,
    youtube_allowed_countries,
    youtube_blocked_countries,
    youtube_first_comment,
    youtube_thumbnail,
    youtube_recording_date,

    // TikTok metadata
    tiktok_post_mode,
    tiktok_allow_comments,
    tiktok_allow_duet,
    tiktok_allow_stitch,
    tiktok_disclosure_content,
    tiktok_brand_content,

    // Instagram metadata - ENHANCED
    instagram_post_type, // 'feed', 'story', or 'reel'
    instagram_media_type, // 'feed' or 'stories'
    instagram_collaborators,
    instagram_user_tags,
    instagram_location_id,
    instagram_title, // Override title for Instagram
    instagram_alt_text, // Extended alt text
    instagram_first_comment, // Auto-post first comment
    instagram_audio_name,
    instagram_share_to_feed,

    // Facebook metadata
    facebook_page_id,
    facebook_media_type,

    // Pinterest metadata
    pinterest_board_id,
    pinterest_title,
    pinterest_link,
    pinterest_alt_text,

    // LinkedIn metadata
    linkedin_page_id,
    linkedin_article_url,
    linkedin_destinations,

    // Twitter metadata - Complete settings
    twitter_reply_to_tweet_id,
    twitter_quote_tweet_id,
    twitter_reply_settings,
    twitter_for_super_followers_only,
    twitter_share_with_followers,
    twitter_tagged_user_ids,
    twitter_exclude_reply_user_ids,
    twitter_place_id,
    twitter_community_id,
    twitter_dm_deep_link,
    twitter_nullcast,
    twitter_thumbnail_url,
    twitter_custom_title,
    twitter_thread_mode,
    twitter_post_as_long_tweet,
    twitter_poll_enabled,
    twitter_poll_options,
    twitter_poll_duration,

    // Generic fields
    alt_text, // Global alt text for all platforms
    first_comment, // Global first comment

    // Webhook configuration for this specific post
    webhook_url, // URL to send status callbacks
    webhook_secret, // Secret for HMAC signature verification
  } = body;

  // Parse platforms array from various formats (JSON string, comma-separated, actual array)
  const platforms = parseArrayField(rawPlatforms, 'platforms');
  console.log('Parsed platforms:', platforms);

  // Reject common invalid field name variants with a 400 error
  const invalidFieldNames = ['account_id', 'id', 'social_account_id', 'account_IDs', 'accountIds', 'accountID', 'account_ID', 'Account_ids', 'Account_IDs'];
  const foundInvalid = invalidFieldNames.filter(f => body[f] !== undefined);
  if (foundInvalid.length > 0) {
    return new Response(
      JSON.stringify({
        error: `Invalid field name(s): ${foundInvalid.join(', ')}. Use "account_ids" (lowercase) or "ACCOUNT_IDS" (uppercase) only.`,
        accepted_field_names: ['account_ids', 'ACCOUNT_IDS'],
        accepted_formats: {
          'JSON array of strings (recommended)': '["uuid-1", "uuid-2"]',
          'Comma-separated string': '"uuid-1, uuid-2"',
          'Single string': '"uuid-1"',
          'JSON array of numbers (not recommended for large IDs)': '[123, 456]',
        },
        warning: 'Always send IDs as strings. Large numeric IDs (e.g. 34767551309502570) exceed JavaScript safe integer limit and will lose precision.'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Normalize account_ids from the two accepted field names only
  const rawAccountIds = providedAccountIds || capitalAccountIds;
  
  // Warn about numeric IDs that may lose precision
  if (typeof rawAccountIds === 'number') {
    console.warn(`⚠️ account ID sent as number (${rawAccountIds}). Large IDs may lose precision. Always send IDs as strings.`);
  }
  if (Array.isArray(rawAccountIds)) {
    rawAccountIds.forEach((v: unknown) => {
      if (typeof v === 'number') {
        console.warn(`⚠️ account ID element sent as number (${v}). Always send IDs as strings.`);
      }
    });
  }
  
  const account_ids = parseArrayField(rawAccountIds, 'account_ids');
  console.log('Parsed account_ids:', account_ids);
  
  // If no account_ids resolved and no user_identifier, log info
  if (account_ids.length === 0 && !user_identifier) {
    console.log('ℹ️ No account filtering applied. Accepted field names: account_ids, ACCOUNT_IDS');
  }

  if (!platforms || platforms.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'platforms array is required',
        hint: 'Provide platforms as: JSON array (["instagram", "facebook"]), comma-separated (instagram,facebook), or actual array'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Process media_urls if provided - download and upload each URL
  // Validate that every media_file_id is a proper UUID — the posts.media_file_ids
  // column is UUID[] and a non-UUID value (e.g. a Cloudinary URL from a wrong n8n
  // expression) would cause a 22P02 "invalid input syntax for type uuid" at insert.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let rawMediaFileIds: string[] = Array.isArray(media_file_ids) ? [...media_file_ids] :
    (media_file_ids ? [media_file_ids] : []);

  if (rawMediaFileIds.length > 0) {
    const invalid = rawMediaFileIds.filter((id: string) => typeof id !== 'string' || !UUID_RE.test(id.trim()));
    if (invalid.length > 0) {
      const sample = invalid[0];
      const hint = /^https?:\/\//i.test(String(sample).trim())
        ? ' It looks like you passed a URL. Use the "media_urls" field (Media Source = URL) instead of "media_file_ids" (Media Source = Media File ID), or use the Media → Upload node first and reference the returned id (UUID), not file_path (URL).'
        : '';
      return new Response(
        JSON.stringify({
          error: `Invalid media_file_ids: every ID must be a UUID. Got "${String(sample).slice(0, 120)}".${hint}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
  }
  let finalMediaFileIds: string[] = rawMediaFileIds.map((id: string) => id.trim());

  // Combine media_url (singular) and media_urls (plural) - accept both formats
  const combinedMediaUrls = media_urls || media_url;

  // Handle media_urls - can be array, JSON string array, or single URL
  let mediaUrlsArray: string[] = [];
  if (Array.isArray(combinedMediaUrls)) {
    mediaUrlsArray = combinedMediaUrls;
  } else if (typeof combinedMediaUrls === 'string' && combinedMediaUrls.trim()) {
    // Check if it's a JSON array string like '["url1", "url2"]'
    const trimmed = combinedMediaUrls.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          mediaUrlsArray = parsed;
          console.log('Parsed JSON array string into', parsed.length, 'URLs');
        }
      } catch (e) {
        console.log('Failed to parse as JSON array, treating as single URL');
        mediaUrlsArray = [combinedMediaUrls];
      }
    } else {
      // Single URL or comma-separated URLs
      if (trimmed.includes(',') && !trimmed.includes('?')) {
        // Comma-separated (but not if comma is in query params)
        mediaUrlsArray = trimmed.split(',').map(u => u.trim()).filter(u => u);
        console.log('Split comma-separated into', mediaUrlsArray.length, 'URLs');
      } else {
        mediaUrlsArray = [combinedMediaUrls];
      }
    }
  }

  console.log('Media URLs to process:', mediaUrlsArray);

  if (mediaUrlsArray.length > 0) {
    console.log('Processing', mediaUrlsArray.length, 'media URLs...');
    const uploadErrors: string[] = [];

    for (const url of mediaUrlsArray) {
      if (typeof url === 'string' && url.trim()) {
        const result = await downloadAndUploadMedia(supabase, userId, url.trim());
        if (result.id) {
          finalMediaFileIds.push(result.id);
        } else if (result.error) {
          uploadErrors.push(`${url}: ${result.error}`);
        }
      }
    }

    if (uploadErrors.length > 0 && finalMediaFileIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'Failed to upload media from URLs',
          details: uploadErrors, // Return actual errors — these are our own messages, not sensitive DB errors
          hint: 'Ensure all media URLs are publicly accessible direct links to image/video files'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (uploadErrors.length > 0) {
      console.warn('Some media URLs failed to upload:', uploadErrors);
    }

    console.log('Final media_file_ids after URL processing:', finalMediaFileIds);
  }

  // Process base64 media if provided
  const mediaBase64Array = Array.isArray(media_base64) ? media_base64 :
    (media_base64 ? [media_base64] : []);

  if (mediaBase64Array.length > 0) {
    console.log('Processing', mediaBase64Array.length, 'base64 media items...');
    const uploadErrors: string[] = [];

    for (let i = 0; i < mediaBase64Array.length; i++) {
      const base64Data = mediaBase64Array[i];
      if (typeof base64Data === 'string' && base64Data.trim()) {
        try {
          const mediaFile = await uploadFileFromBase64(supabase, userId, base64Data.trim());
          if (mediaFile?.id) {
            finalMediaFileIds.push(mediaFile.id);
          }
        } catch (err: any) {
          uploadErrors.push(`base64[${i}]: ${err.message}`);
        }
      }
    }

    if (uploadErrors.length > 0) {
      console.warn('Some base64 media failed to upload:', uploadErrors);
    }
  }

  // Validate account_ids if provided - supports internal UUID 'id', 'platform_user_id', and 'user_identifier'
  // Note: account_ids is already parsed by parseArrayField above
  let validatedAccountIds: string[] | undefined;
  let selectedAccounts: any[] = [];
  let accountIdsArray = account_ids; // Already parsed as string[] above

  // Also check for user_identifier (username-based selection like "mturpo (instagram)")
  if (accountIdsArray.length === 0 && user_identifier) {
    console.log('Looking up account by user_identifier:', user_identifier);

    // Parse user_identifier format: "username (platform)" or just "username"
    const identifierMatch = user_identifier.match(/^(.+?)\s*\((\w+)\)$/);
    let username = user_identifier;
    let platformFilter = null;

    if (identifierMatch) {
      username = identifierMatch[1].trim();
      platformFilter = identifierMatch[2].toLowerCase();
    }

    const query = supabase
      .from('social_accounts')
      .select('id, platform, platform_user_id, platform_username')
      .eq('user_id', userId)
      .eq('is_active', true)
      .ilike('platform_username', username);

    if (platformFilter) {
      query.eq('platform', platformFilter);
    }

    const { data: accountsByUsername, error: usernameError } = await query;

    if (usernameError) {
      console.error('Error looking up by username:', usernameError);
    } else if (accountsByUsername && accountsByUsername.length > 0) {
      accountIdsArray = accountsByUsername.map((a: any) => a.id);
      console.log('Found accounts by username:', accountIdsArray);
    }
  }

  if (accountIdsArray.length > 0) {
    console.log('Looking up accounts with IDs:', accountIdsArray);

    // First try to find by internal UUID id
    const { data: accountsById, error: byIdError } = await supabase
      .from('social_accounts')
      .select('id, platform, platform_user_id, account_metadata')
      .eq('user_id', userId)
      .eq('is_active', true)
      .in('id', accountIdsArray);

    if (byIdError) {
      console.error('Error looking up by id:', byIdError);
    }

    // Also try to find by platform_user_id (Instagram/Facebook uses numeric IDs)
    const { data: accountsByPlatformId, error: byPlatformIdError } = await supabase
      .from('social_accounts')
      .select('id, platform, platform_user_id, account_metadata')
      .eq('user_id', userId)
      .eq('is_active', true)
      .in('platform_user_id', accountIdsArray);

    if (byPlatformIdError) {
      console.error('Error looking up by platform_user_id:', byPlatformIdError);
    }

    // Merge results (dedupe by id)
    const allAccounts = [...(accountsById || []), ...(accountsByPlatformId || [])];
    const uniqueAccounts = allAccounts.filter((account, index, self) =>
      index === self.findIndex(a => a.id === account.id)
    );
    selectedAccounts = uniqueAccounts;

    console.log('Found accounts by id:', accountsById?.length || 0);
    console.log('Found accounts by platform_user_id:', accountsByPlatformId?.length || 0);
    console.log('Total unique accounts:', uniqueAccounts.length);

    if (uniqueAccounts.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'No valid account IDs found. You can use: internal UUID, platform_user_id (e.g., Instagram numeric ID), or user_identifier (e.g., "username (instagram)"). Use GET /api/v1/accounts to see your available accounts.',
          provided_ids: accountIdsArray
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check that platforms match the account platforms
    const accountPlatforms = uniqueAccounts.map((a: any) => a.platform);
    const missingPlatforms = platforms.filter((p: string) => !accountPlatforms.includes(p));
    if (missingPlatforms.length > 0) {
      return new Response(
        JSON.stringify({
          error: `No account provided for platforms: ${missingPlatforms.join(', ')}. Either add account_ids for these platforms or remove them from platforms array.`,
          available_accounts: uniqueAccounts.map((a: any) => ({ id: a.id, platform: a.platform, platform_user_id: a.platform_user_id }))
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    validatedAccountIds = uniqueAccounts.map((a: any) => a.id);
    console.log('Using specific account_ids (internal UUIDs):', validatedAccountIds);
  }

  // Build platform-specific metadata object
  const metadata: Record<string, any> = {};

  // Store account_ids in metadata if provided (use 'selected_account_ids' to match process-post expectation)
  if (validatedAccountIds) {
    metadata.selected_account_ids = validatedAccountIds;
  }

  if (linkedin_destinations !== undefined) {
    try {
      metadata.linkedin_destinations = normalizeLinkedInDestinationSelections(
        linkedin_destinations,
        selectedAccounts,
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : "Invalid LinkedIn destinations" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
  }

  // YouTube metadata - map to process-post expected format (including Shorts support)
  if (platforms.includes('youtube')) {
    metadata.youtube_visibility = youtube_privacy || 'private';
    metadata.youtube_title = youtube_title;
    metadata.youtube_description = youtube_description;
    metadata.youtube_tags = Array.isArray(youtube_tags) ? youtube_tags :
      (typeof youtube_tags === 'string' ? youtube_tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []);
    metadata.youtube_category = youtube_category || '22';
    metadata.youtube_made_for_kids = youtube_made_for_kids ?? false;
    metadata.youtube_allow_embedding = youtube_allow_embedding ?? true;
    metadata.youtube_public_stats_viewable = youtube_public_stats_viewable ?? true;
    metadata.youtube_contains_synthetic_media = youtube_contains_synthetic_media ?? false;
    metadata.youtube_has_paid_promotion = youtube_has_paid_product_placement ?? false;
    metadata.youtube_notify_subscribers = youtube_notify_subscribers ?? true;
    metadata.youtube_video_language = youtube_default_language || null;
    metadata.youtube_audio_language = youtube_default_audio_language || null;
    metadata.youtube_license = youtube_license || 'youtube';
    metadata.youtube_allowed_countries = Array.isArray(youtube_allowed_countries) ? youtube_allowed_countries :
      (typeof youtube_allowed_countries === 'string' ? youtube_allowed_countries.split(',').map((c: string) => c.trim()).filter(Boolean) : null);
    metadata.youtube_blocked_countries = Array.isArray(youtube_blocked_countries) ? youtube_blocked_countries :
      (typeof youtube_blocked_countries === 'string' ? youtube_blocked_countries.split(',').map((c: string) => c.trim()).filter(Boolean) : null);
    metadata.youtube_first_comment = youtube_first_comment || first_comment || null;
    metadata.youtube_thumbnail_url = youtube_thumbnail || null;
    metadata.youtube_recording_date = youtube_recording_date || null;
    // YouTube Shorts support - video_type can be 'video' or 'short'
    metadata.youtube_video_type = body.youtube_video_type || 'video';
  }

  // TikTok metadata
  if (platforms.includes('tiktok')) {
    metadata.tiktok = {
      postMode: tiktok_post_mode || 'DIRECT_POST',
      allowComments: tiktok_allow_comments ?? true,
      allowDuet: tiktok_allow_duet ?? true,
      allowStitch: tiktok_allow_stitch ?? true,
      disclosureContent: tiktok_disclosure_content ?? false,
      brandContent: tiktok_brand_content ?? false,
    };
  }

  // Instagram metadata - ENHANCED with all n8n fields
  if (platforms.includes('instagram')) {
    const normalizedInstagramPostType = instagram_post_type
      || (instagram_media_type === 'stories' ? 'story' : 'feed');

    metadata.instagram = {
      mediaType: instagram_media_type || 'feed', // 'feed' or 'stories'
      collaborators: instagram_collaborators || [],
      userTags: instagram_user_tags || [],
      locationId: instagram_location_id,
      title: instagram_title || title, // Override title for Instagram
      altText: instagram_alt_text || alt_text,
     firstComment: instagram_first_comment || first_comment,
      audioName: instagram_audio_name,
      shareToFeed: instagram_share_to_feed ?? true,
    };
    metadata.instagram_post_type = normalizedInstagramPostType;
    metadata.instagram_first_comment = instagram_first_comment || first_comment || null;
  }

  // Facebook metadata (including Reels support)
  if (platforms.includes('facebook')) {
    metadata.facebook = {
      pageId: facebook_page_id,
      mediaType: facebook_media_type, // 'REELS' or 'STORIES'
    };
    // Facebook Reels support - post_type can be 'feed', 'story', or 'reel'
    metadata.facebook_post_type = body.facebook_post_type || 'feed';
    metadata.facebook_reel_description = body.facebook_reel_description || null;
    
    metadata.facebook_location = body.facebook_location || null;
    metadata.facebook_first_comment = body.facebook_first_comment || first_comment || null;
    metadata.facebook_link = body.facebook_link || null;
    metadata.facebook_share_to_story = body.facebook_share_to_story ?? false;
  }

  // Pinterest metadata - with board validation
  if (platforms.includes('pinterest')) {
    let validatedBoardId = pinterest_board_id;

    // Get the Pinterest account for this user
    let pinterestAccountQuery = supabase
      .from('social_accounts')
      .select('id, access_token, platform_user_id')
      .eq('user_id', userId)
      .eq('platform', 'pinterest')
      .eq('is_active', true);

    // If specific account IDs were validated, filter by those
    if (validatedAccountIds && validatedAccountIds.length > 0) {
      // Get Pinterest accounts from the validated list
      const { data: validatedPinterestAccounts } = await supabase
        .from('social_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('platform', 'pinterest')
        .eq('is_active', true)
        .in('id', validatedAccountIds);

      if (validatedPinterestAccounts && validatedPinterestAccounts.length > 0) {
        pinterestAccountQuery = pinterestAccountQuery.in('id', validatedPinterestAccounts.map((a: any) => a.id));
      }
    }

    const { data: pinterestAccount, error: pinterestAccountError } = await pinterestAccountQuery.limit(1).maybeSingle();

    if (pinterestAccountError) {
      console.error('Error fetching Pinterest account:', pinterestAccountError);
    }

    if (pinterestAccount?.access_token) {
      // Fetch actual boards from Pinterest API to validate
      try {
        const boardsResponse = await fetch('https://api.pinterest.com/v5/boards', {
          headers: {
            'Authorization': `Bearer ${pinterestAccount.access_token}`,
          },
        });

        if (boardsResponse.ok) {
          const boardsData = await boardsResponse.json();
          const actualBoards = boardsData.items || [];
          console.log(`Found ${actualBoards.length} Pinterest boards for validation`);

          if (pinterest_board_id) {
            // Check if the provided board ID is valid
            const boardExists = actualBoards.some((b: any) => b.id === pinterest_board_id);

            if (!boardExists) {
              // The provided ID doesn't match any board - it might be a user ID or invalid
              console.warn(`Provided pinterest_board_id "${pinterest_board_id}" not found in user's boards. User might have provided their Pinterest user ID instead of a board ID.`);

              // Auto-select the first available board
              if (actualBoards.length > 0) {
                validatedBoardId = actualBoards[0].id;
                console.log(`Auto-selected first available board: ${validatedBoardId} (${actualBoards[0].name})`);
              } else {
                console.error('No Pinterest boards available for this user');
              }
            } else {
              console.log(`Validated pinterest_board_id: ${pinterest_board_id}`);
            }
          } else {
            // No board ID provided, auto-select the first one
            if (actualBoards.length > 0) {
              validatedBoardId = actualBoards[0].id;
              console.log(`No board ID provided, auto-selected first board: ${validatedBoardId} (${actualBoards[0].name})`);
            } else {
              console.error('No Pinterest boards available and none specified');
            }
          }
        } else {
          console.error('Failed to fetch Pinterest boards for validation:', boardsResponse.status);
        }
      } catch (boardFetchError) {
        console.error('Error fetching Pinterest boards:', boardFetchError);
      }
    }

    metadata.pinterest = {
      boardId: validatedBoardId,
      title: pinterest_title || title,
      link: pinterest_link,
      altText: pinterest_alt_text || alt_text,
    };
  }

  // LinkedIn metadata
  if (platforms.includes('linkedin')) {
    metadata.linkedin = {
      pageId: linkedin_page_id,
      articleUrl: linkedin_article_url,
    };
  }

  // Twitter metadata - Complete settings with process-post expected format
  if (platforms.includes('twitter')) {
    metadata.twitter_reply_to_tweet_id = twitter_reply_to_tweet_id || null;
    metadata.twitter_quote_tweet_url = twitter_quote_tweet_id || null; // Map ID to URL format
    metadata.twitter_reply_settings = twitter_reply_settings || 'everyone';
    metadata.twitter_for_super_followers_only = twitter_for_super_followers_only ?? false;
    metadata.twitter_share_with_followers = twitter_share_with_followers ?? true;
    metadata.twitter_tagged_user_ids = parseArrayField(twitter_tagged_user_ids, 'twitter_tagged_user_ids');
    metadata.twitter_exclude_reply_user_ids = parseArrayField(twitter_exclude_reply_user_ids, 'twitter_exclude_reply_user_ids');
    metadata.twitter_place_id = twitter_place_id || null;
    metadata.twitter_community_id = twitter_community_id || null;
    metadata.twitter_dm_deep_link = twitter_dm_deep_link || null;
    metadata.twitter_nullcast = twitter_nullcast ?? false;
    metadata.twitter_thumbnail_url = twitter_thumbnail_url || null;
    metadata.twitter_custom_title = twitter_custom_title || null;
    metadata.twitter_thread_mode = twitter_thread_mode ?? false;
    metadata.twitter_post_as_long_tweet = twitter_post_as_long_tweet ?? false;
    metadata.twitter_poll_enabled = twitter_poll_enabled ?? false;
    metadata.twitter_poll_options = twitter_poll_enabled ? parseArrayField(twitter_poll_options, 'twitter_poll_options') : null;
    metadata.twitter_poll_duration = twitter_poll_enabled ? (parseInt(String(twitter_poll_duration)) || 1440) : null;
  }

  // Store operation type and async settings
  metadata.operation = operation || 'upload_photos';
  metadata.upload_async = upload_async ?? true;
  metadata.wait_for_completion = wait_for_completion ?? true;
  metadata.poll_interval = poll_interval || 10;
  metadata.timeout = timeout || 600;
  // Use request timezone, then user's preferred timezone from settings, then UTC
  const effectiveTimezone = timezone || userPreferredTimezone || 'UTC';
  metadata.timezone = effectiveTimezone;
  console.log(`Timezone resolution: request=${timezone || 'none'}, userPref=${userPreferredTimezone || 'none'}, effective=${effectiveTimezone}`);

  // Store global alt_text and first_comment if provided
  if (alt_text) metadata.alt_text = alt_text;
  if (first_comment) metadata.first_comment = first_comment;

  // Store webhook configuration for per-request callbacks
  if (webhook_url) {
    metadata.webhook_url = webhook_url;
    if (webhook_secret) metadata.webhook_secret = webhook_secret;
  }

  console.log('Built metadata:', JSON.stringify(metadata, null, 2));

  // Use title as caption fallback if caption not provided
  const finalCaption = caption || title || '';

  // Handle scheduled_at with scheduled_date fallback
  let finalScheduledAt = scheduled_at || scheduled_date || null;

  // Convert scheduled_at to proper UTC if a non-UTC timezone is active
  if (finalScheduledAt && effectiveTimezone && effectiveTimezone !== 'UTC') {
    try {
      // Check if the datetime already has a timezone offset (e.g., +03:00, Z)
      const hasOffset = /[Zz]|[+-]\d{2}:\d{2}$/.test(finalScheduledAt);
      if (!hasOffset) {
        // The datetime is "naive" (e.g., "2026-03-29 11:35:00") — treat it as local time in the given timezone
        // Use Intl.DateTimeFormat to compute the UTC offset for the given timezone at that date
        const naiveDate = new Date(finalScheduledAt.replace(' ', 'T'));
        
        // Get the offset by comparing UTC formatter vs timezone formatter
        const utcFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'UTC',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false,
        });
        const tzFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: effectiveTimezone,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false,
        });

        // Create a reference point to find the offset
        const refDate = new Date(finalScheduledAt.replace(' ', 'T') + 'Z');
        const utcParts = utcFormatter.formatToParts(refDate);
        const tzParts = tzFormatter.formatToParts(refDate);

        const getPart = (parts: Intl.DateTimeFormatPart[], type: string) => 
          parseInt(parts.find(p => p.type === type)?.value || '0');

        const utcHour = getPart(utcParts, 'hour');
        const tzHour = getPart(tzParts, 'hour');
        const utcDay = getPart(utcParts, 'day');
        const tzDay = getPart(tzParts, 'day');

        let offsetHours = tzHour - utcHour;
        if (tzDay > utcDay) offsetHours += 24;
        if (tzDay < utcDay) offsetHours -= 24;

        // Subtract the offset to convert local time to UTC
        const localDate = new Date(finalScheduledAt.replace(' ', 'T') + 'Z');
        localDate.setUTCHours(localDate.getUTCHours() - offsetHours);
        
        finalScheduledAt = localDate.toISOString();
        console.log(`Converted scheduled_at from ${effectiveTimezone} to UTC: ${finalScheduledAt}`);
      }
    } catch (tzError) {
      console.error('Error converting timezone, using as-is:', tzError);
    }
  }

  // Enforce plan post quotas before insert (DB trigger is the hard backstop)
  try {
    const { data: quotaAllowed, error: quotaError } = await supabase.rpc('can_create_post', {
      p_user_id: userId,
    });
    if (quotaError) {
      console.error('Quota check error (continuing to insert; trigger will enforce):', quotaError);
    } else if (quotaAllowed === false) {
      console.log('Post quota exceeded for user:', userId);
      return new Response(
        JSON.stringify({
          error: 'Post quota exceeded. Free plans are limited to 2 posts per day and 30 posts per month. Upgrade to continue.',
          code: 'POST_QUOTA_EXCEEDED',
        }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (quotaCheckErr) {
    console.error('Quota preflight failed (trigger will enforce):', quotaCheckErr);
  }

  // Create the post with metadata
  const { data: post, error: postError } = await supabase
    .from('posts')
    .insert({
      user_id: userId,
      caption: finalCaption,
      platforms,
      media_file_ids: finalMediaFileIds,
      scheduled_at: finalScheduledAt,
      status: finalScheduledAt ? 'scheduled' : 'pending',
      metadata,
      source: 'api'
    })
    .select()
    .single();

  if (postError) {
    console.error('Error creating post:', postError);
    const msg = postError.message || '';
    if (msg.includes('POST_QUOTA_DAILY_EXCEEDED') || msg.includes('POST_QUOTA_MONTHLY_EXCEEDED') || msg.includes('POST_QUOTA_DENIED')) {
      return new Response(
        JSON.stringify({
          error: msg.replace(/^.*POST_QUOTA_[A-Z_]+:\s*/i, '') || 'Post quota exceeded.',
          code: 'POST_QUOTA_EXCEEDED',
        }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ error: 'Failed to create post. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Note: We do NOT create platform_posts here - process-post will create them
  // with the correct social_account_id assignment. Creating them here without
  // social_account_id causes duplicate records.

  // Only invoke process-post for immediate (non-scheduled) posts
  if (!finalScheduledAt) {
    try {
      const processResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/process-post`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
          },
          body: JSON.stringify({ post_id: post.id })
        }
      );

      const processResult = await processResponse.json();
      console.log('Process post result:', processResult);
    } catch (error) {
      console.error('Error invoking process-post:', error);
    }
  } else {
    console.log(`Post ${post.id} scheduled for ${finalScheduledAt} — skipping immediate processing`);
  }

  return new Response(
    JSON.stringify({
      success: true,
      post,
      scheduled: !!finalScheduledAt,
      message: finalScheduledAt ? 'Post scheduled successfully' : 'Post created and processing started',
      metadata_applied: metadata,
      account_ids_used: validatedAccountIds || 'auto-selected first account per platform'
    }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle POST /api/v1/upload-media - Upload single or multiple media files
async function handleUploadMedia(supabase: any, userId: string, request: Request) {
  const corsHeaders = restrictedCorsHeaders(request);
  console.log('Uploading media for user:', userId);

  const contentType = request.headers.get('content-type') || '';

  // Handle JSON body (URLs or base64 data)
  if (contentType.includes('application/json')) {
    const body = await request.json();
    const { media_url, media_urls, file_data, files_data, file_name, file_names } = body;

    const uploadedFiles: any[] = [];
    const errors: any[] = [];

    // Handle single or multiple URLs
    const urls = media_urls || (media_url ? [media_url] : []);
    for (let i = 0; i < urls.length; i++) {
      try {
        const mediaFile = await uploadFileFromUrl(supabase, userId, urls[i]);
        uploadedFiles.push(mediaFile);
      } catch (error: any) {
        errors.push({ index: i, url: urls[i], error: error.message });
      }
    }

    // Handle single or multiple base64 data
    const dataItems = files_data || (file_data ? [file_data] : []);
    const names = file_names || (file_name ? [file_name] : []);
    for (let i = 0; i < dataItems.length; i++) {
      try {
        const mediaFile = await uploadFileFromBase64(supabase, userId, dataItems[i], names[i]);
        uploadedFiles.push(mediaFile);
      } catch (error: any) {
        errors.push({ index: i, error: error.message });
      }
    }

    if (uploadedFiles.length === 0 && errors.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No media provided. Use media_url, media_urls, file_data, or files_data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: uploadedFiles.length > 0,
        media_files: uploadedFiles,
        media_file_ids: uploadedFiles.map(f => f.id),
        errors: errors.length > 0 ? errors : undefined,
        total_uploaded: uploadedFiles.length,
        total_failed: errors.length
      }),
      { status: uploadedFiles.length > 0 ? 201 : 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Handle multipart form data (file uploads)
  const formData = await request.formData();
  const files: File[] = [];

  // Collect all files from 'file', 'files', 'file[]', or 'files[]' fields
  for (const [key, value] of formData.entries()) {
    if ((key === 'file' || key === 'files' || key === 'file[]' || key === 'files[]') && value instanceof File) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: 'No files provided. Use field name: file, files, file[], or files[]' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const uploadedFiles: any[] = [];
  const errors: any[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      // Convert to base64 for Cloudinary upload
      const arrayBuffer = await file.arrayBuffer();
      // Use chunked base64 conversion for performance (avoids byte-by-byte loop timeout on large files)
      const bytes = new Uint8Array(arrayBuffer);
      const CHUNK_SIZE = 8192;
      let binary = '';
      for (let j = 0; j < bytes.length; j += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(j, Math.min(j + CHUNK_SIZE, bytes.length)));
      }
      const base64 = btoa(binary);
      const fileData = `data:${file.type};base64,${base64}`;

      const mediaFile = await uploadToCloudinary(supabase, userId, {
        fileData,
        fileName: file.name,
        fileType: file.type.startsWith('video/') ? 'video' : 'image'
      });

      uploadedFiles.push(mediaFile);
    } catch (error: any) {
      errors.push({ index: i, file_name: file.name, error: error.message });
    }
  }

  return new Response(
    JSON.stringify({
      success: uploadedFiles.length > 0,
      media_files: uploadedFiles,
      media_file_ids: uploadedFiles.map(f => f.id),
      errors: errors.length > 0 ? errors : undefined,
      total_uploaded: uploadedFiles.length,
      total_failed: errors.length
    }),
    { status: uploadedFiles.length > 0 ? 201 : 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle GET /api/v1/accounts - List connected accounts with profile info
async function handleGetAccounts(req: Request, supabase: any, userId: string, url?: URL) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Fetching accounts for user:', userId);

  const platformFilter = url?.searchParams.get('platform') || null;
  if (platformFilter) {
    console.log('Filtering accounts by platform:', platformFilter);
  }

  // Fetch accounts with their associated social profile name
  let query = supabase
    .from('social_accounts')
    .select(`
      id, 
      platform, 
      platform_username, 
      platform_user_id, 
      avatar_url, 
      is_active, 
      connected_at,
      social_profile_id,
      account_metadata,
      social_profiles!social_accounts_social_profile_id_fkey (
        id,
        name
      )
    `)
    .eq('user_id', userId)
    .eq('is_active', true);

  if (platformFilter) {
    query = query.eq('platform', platformFilter);
  }

  const { data: accounts, error } = await query;

  if (error) {
    console.error('Error fetching accounts:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch accounts. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Transform the response to include profile_name at the top level
  const transformedAccounts = (accounts || []).map((account: any) => ({
    id: account.id,
    platform: account.platform,
    platform_username: account.platform_username,
    platform_user_id: account.platform_user_id,
    avatar_url: account.avatar_url,
    is_active: account.is_active,
    connected_at: account.connected_at,
    social_profile_id: account.social_profile_id,
    profile_name: account.social_profiles?.name || null,
    ...(account.platform === 'linkedin' ? {
      linkedin_destinations: listLinkedInDestinations(
        account.platform_username || 'LinkedIn User',
        account.account_metadata,
      ),
    } : {}),
  }));

  return new Response(
    JSON.stringify({
      success: true,
      accounts: transformedAccounts,
      usage_hint: 'Use the "id" field in the "account_ids" parameter when creating posts to target specific accounts'
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle GET /api/v1/posts - Get post history
async function handleGetPosts(req: Request, supabase: any, userId: string, url: URL) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Fetching posts for user:', userId);

  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const status = url.searchParams.get('status');
  const platform = url.searchParams.get('platform');
  const accountId = url.searchParams.get('account_id');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  // If filtering by account_id, we need to get matching post IDs first
  let postIdFilter: string[] | null = null;
  if (accountId) {
    const { data: ppRows } = await supabase
      .from('platform_posts')
      .select('post_id')
      .eq('social_account_id', accountId);
    postIdFilter = ppRows?.map((r: any) => r.post_id) || [];
    if (postIdFilter.length === 0) {
      return new Response(
        JSON.stringify({ success: true, posts: [], limit, offset }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  let query = supabase
    .from('posts')
    .select(`
      id, caption, platforms, status, scheduled_at, posted_at, created_at,
      platform_posts (id, platform, status, platform_post_url, error_message, posted_at)
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }
  if (platform) {
    query = query.contains('platforms', [platform]);
  }
  if (postIdFilter) {
    query = query.in('id', postIdFilter);
  }
  if (dateFrom) {
    query = query.gte('created_at', dateFrom);
  }
  if (dateTo) {
    // If date_to is at midnight (start of day), adjust to end of day so posts on that date are included
    let adjustedDateTo = dateTo;
    if (dateTo.endsWith('T00:00:00') || dateTo.endsWith('T00:00:00.000') || dateTo.endsWith('T00:00:00Z')) {
      adjustedDateTo = dateTo.replace(/T00:00:00.*$/, 'T23:59:59.999Z');
    }
    console.log('Date to filter (adjusted):', adjustedDateTo);
    query = query.lte('created_at', adjustedDateTo);
  }

  const { data: posts, error } = await query;

  if (error) {
    console.error('Error fetching posts:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch posts. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, posts, limit, offset, filters: { platform, account_id: accountId, date_from: dateFrom, date_to: dateTo } }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle POST /api/v1/webhooks - Register a webhook for post status updates
async function handleRegisterWebhook(req: Request, supabase: any, userId: string, body: any) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Registering webhook for user:', userId, 'with body:', JSON.stringify(body, null, 2));

  const { webhook_url, events } = body;

  if (!webhook_url) {
    return new Response(
      JSON.stringify({ error: 'webhook_url is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const validationError = validateWebhookTarget(webhook_url);
  if (validationError) {
    return new Response(
      JSON.stringify({ error: validationError }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Default events if not specified
  const subscribedEvents = events || ['post.completed', 'post.failed', 'post.published'];

  // Create webhook entry in app_settings with user-specific key
  const webhookId = crypto.randomUUID();
  const webhookKey = `n8n_webhook_${userId}_${webhookId}`;

  const { error: settingsError } = await supabase
    .from('app_settings')
    .upsert({
      key: webhookKey,
      value: {
        webhook_id: webhookId,
        user_id: userId,
        webhook_url,
        events: subscribedEvents,
        created_at: new Date().toISOString(),
        is_active: true
      },
      description: `n8n webhook for user ${userId}`
    });

  if (settingsError) {
    console.error('Error saving webhook:', settingsError);
    return new Response(
      JSON.stringify({ error: 'Failed to register webhook. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log('Webhook registered successfully:', webhookId);

  return new Response(
    JSON.stringify({
      success: true,
      webhook: {
        id: webhookId,
        webhook_url,
        events: subscribedEvents,
        status: 'active'
      }
    }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle GET /api/v1/webhooks - List user's webhooks
async function handleGetWebhooks(req: Request, supabase: any, userId: string) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Fetching webhooks for user:', userId);

  const { data: settings, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .like('key', `n8n_webhook_${userId}_%`);

  if (error) {
    console.error('Error fetching webhooks:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch webhooks. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const webhooks = (settings || []).map((s: any) => ({
    id: s.value.webhook_id,
    webhook_url: s.value.webhook_url,
    events: s.value.events,
    is_active: s.value.is_active,
    created_at: s.value.created_at
  }));

  return new Response(
    JSON.stringify({ success: true, webhooks }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle DELETE /api/v1/webhooks/:id - Delete a webhook
async function handleDeleteWebhook(req: Request, supabase: any, userId: string, webhookId: string) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Deleting webhook:', webhookId, 'for user:', userId);

  const webhookKey = `n8n_webhook_${userId}_${webhookId}`;

  const { error } = await supabase
    .from('app_settings')
    .delete()
    .eq('key', webhookKey);

  if (error) {
    console.error('Error deleting webhook:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to delete webhook. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, message: 'Webhook deleted' }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle POST /api/v1/webhooks/test - Test a webhook by sending a sample payload
async function handleTestWebhook(req: Request, supabase: any, userId: string, body: any) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Testing webhook for user:', userId);

  const { webhook_url } = body;

  if (!webhook_url) {
    return new Response(
      JSON.stringify({ error: 'webhook_url is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const validationError = validateWebhookTarget(webhook_url);
  if (validationError) {
    return new Response(
      JSON.stringify({ error: validationError }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const testPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook from Postora',
      user_id: userId,
      post: {
        id: 'test-post-id',
        caption: 'Test post caption',
        platforms: ['facebook', 'instagram'],
        status: 'completed'
      }
    }
  };

  try {
    const response = await postWebhook(webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postora-Event': 'test',
        'X-Postora-Signature': 'test-signature'
      },
      body: JSON.stringify(testPayload)
    });

    const responseText = await response.text();

    return new Response(
      JSON.stringify({
        success: true,
        webhook_response: {
          status: response.status,
          status_text: response.statusText,
          body: responseText.substring(0, 500)
        },
        payload_sent: testPayload
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error testing webhook:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to reach webhook URL. Please verify the URL is correct and accessible.'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

// Handle GET /api/v1/post/:id - Get single post status with platform results
async function handleGetPostById(req: Request, supabase: any, userId: string, postId: string) {
  const corsHeaders = restrictedCorsHeaders(req);
  console.log('Fetching post by ID:', postId, 'for user:', userId);

  const { data: post, error } = await supabase
    .from('posts')
    .select(`
      id, caption, platforms, status, scheduled_at, posted_at, created_at, metadata, source,
      platform_posts (id, platform, status, platform_post_id, platform_post_url, error_message, posted_at, social_account_id)
    `)
    .eq('id', postId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching post:', error);
    return apiError(req, 'Failed to fetch post. Please try again.', 500, 'INTERNAL_ERROR');
  }

  if (!post) {
    return apiError(req, 'Post not found', 404, 'NOT_FOUND');
  }

  return new Response(
    JSON.stringify({
      success: true,
      post: {
        id: post.id,
        caption: post.caption,
        platforms: post.platforms,
        status: post.status,
        scheduled_at: post.scheduled_at,
        posted_at: post.posted_at,
        created_at: post.created_at,
        source: post.source,
        platform_results: (post.platform_posts || []).map((pp: any) => ({
          platform: pp.platform,
          status: pp.status,
          post_id: pp.platform_post_id,
          post_url: pp.platform_post_url,
          error_message: pp.error_message,
          posted_at: pp.posted_at,
          social_account_id: pp.social_account_id,
        }))
      }
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle GET /api/v1/media/:id — Look up a media file by UUID (scoped to the
// authenticated API key's user). Used by the n8n node's "Media File ID" upload
// source to resolve and re-attach previously-uploaded media without re-uploading.
async function handleGetMediaById(req: Request, supabase: any, userId: string, mediaId: string) {
  const corsHeaders = restrictedCorsHeaders(req);

  // Malformed UUID → 400 (do this before any DB query)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(mediaId)) {
    return apiError(req, `'${mediaId}' is not a valid UUID.`, 400, 'INVALID_UUID');
  }

  const { data: media, error } = await supabase
    .from('media_files')
    .select('id, user_id, file_path, file_type, file_size, mime_type, storage_bucket, metadata, created_at')
    .eq('id', mediaId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching media:', error);
    return apiError(req, 'Failed to fetch media. Please try again.', 500, 'INTERNAL_ERROR');
  }

  // No row OR row owned by a different user → single 404.
  // (We never reveal whether an ID exists vs. is just not-owned, to avoid enumeration.)
  if (!media || media.user_id !== userId) {
    return apiError(req, 'Media file not found or not owned by the authenticated user.', 404, 'MEDIA_NOT_FOUND');
  }

  // Resolve the preferred delivery URL from provider state (openinary-first per
  // cdn_storage.read_preference), falling back to file_path.
  let publicUrl: string = media.file_path;
  let readPreference = 'cloudinary';
  try {
    const [{ data: providerRows }, { data: cdnSetting }] = await Promise.all([
      supabase
        .from('media_file_providers')
        .select('provider, status, delivery_url')
        .eq('media_file_id', mediaId)
        .eq('object_version', 1),
      supabase.from('app_settings').select('value').eq('key', 'cdn_storage').maybeSingle(),
    ]);
    if (typeof cdnSetting?.value?.read_preference === 'string') {
      readPreference = cdnSetting.value.read_preference;
    }
    const order = readPreference === 'openinary' ? ['openinary', 'cloudinary'] : ['cloudinary', 'openinary'];
    for (const provider of order) {
      const ready = (providerRows || []).find((p: any) => p.provider === provider && p.status === 'ready' && !!p.delivery_url);
      if (ready) { publicUrl = ready.delivery_url; break; }
    }
  } catch (e) {
    console.warn('Provider-aware URL resolution failed, using file_path:', e);
  }

  return new Response(
    JSON.stringify({
      success: true,
      media: {
        id: media.id,
        file_path: media.file_path,
        public_url: publicUrl,
        file_type: media.file_type,
        file_size: media.file_size,
        mime_type: media.mime_type,
        storage_bucket: media.storage_bucket,
        metadata: media.metadata,
        created_at: media.created_at,
      },
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

// Standardized API error helper
function apiError(req, message: string, status: number, code?: string, details?: any): Response {
  const corsHeaders = restrictedCorsHeaders(req);
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: code || 'ERROR',
        message,
        ...(details ? { details } : {})
      }
    }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Add rate limit headers to any response
function withRateLimitHeaders(response: Response, rateLimit: { remaining: number; resetAt: Date }, endpoint: string): Response {
  const config = RATE_LIMITS[endpoint] || RATE_LIMITS['default'];
  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Limit', config.requests.toString());
  headers.set('X-RateLimit-Remaining', rateLimit.remaining.toString());
  headers.set('X-RateLimit-Reset', rateLimit.resetAt.toISOString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Helper function to send webhook notifications (can be imported by process-post)
async function sendWebhookNotification(
  supabase: any,
  userId: string,
  event: string,
  data: any
) {
  console.log('Sending webhook notification:', event, 'for user:', userId);

  const { data: settings, error } = await supabase
    .from('app_settings')
    .select('value')
    .like('key', `n8n_webhook_${userId}_%`);

  if (error || !settings?.length) {
    console.log('No webhooks found for user:', userId);
    return;
  }

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data
  };

  for (const setting of settings) {
    const webhook = setting.value;

    if (!webhook.is_active) continue;
    if (!webhook.events.includes(event) && !webhook.events.includes('*')) continue;

    try {
      console.log('Sending to webhook:', webhook.webhook_url);
      await fetch(webhook.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Postora-Event': event,
          'X-Postora-Timestamp': payload.timestamp
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.error('Failed to send webhook to:', webhook.webhook_url, error);
    }
  }
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    // Remove /n8n-api prefix from the path
    let path = url.pathname.replace('/n8n-api', '');

    // Normalize path: support both /api/v1/post and /v1/post patterns
    // If path starts with /v1/ but not /api/v1/, add the /api prefix
    if (path.startsWith('/v1/') && !path.startsWith('/api/v1/')) {
      path = '/api' + path;
      console.log(`Path normalized: /v1/* -> ${path}`);
    }

    console.log(`n8n API request: ${req.method} ${path}`);

    // Create Supabase client with service role for API key validation
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get API key from header - support both x-api-key and Authorization header
    let apiKey = req.headers.get('x-api-key');

    // If x-api-key not found, try Authorization header
    if (!apiKey) {
      const authHeader = req.headers.get('authorization');
      if (authHeader) {
        // Support formats: "Apikey xxx", "Bearer xxx", or just "xxx"
        if (authHeader.toLowerCase().startsWith('apikey ')) {
          apiKey = authHeader.substring(7).trim();
        } else if (authHeader.toLowerCase().startsWith('bearer ')) {
          apiKey = authHeader.substring(7).trim();
        } else {
          // Assume it's just the raw API key
          apiKey = authHeader.trim();
        }
      }
    }

    console.log('API key source:', apiKey ? 'found' : 'not found');

    // Authenticate
    const authResult = await authenticateApiKey(supabaseAdmin, apiKey);

    if (!authResult) {
      return apiError(req, 'Invalid or missing API key', 401, 'UNAUTHORIZED');
    }

    const userId = authResult.userId;
    const userPreferredTimezone = authResult.preferredTimezone;

    // Check rate limit
    const ipAddress = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip');
    const rateLimit = await checkRateLimit(supabaseAdmin, userId, path, req.method, ipAddress);

    if (!rateLimit.allowed) {
      console.log('Rate limit exceeded for user:', userId, 'on endpoint:', path);
      return apiError(req, 
        `Too many requests. Please try again after ${rateLimit.resetAt.toISOString()}`,
        429,
        'RATE_LIMIT_EXCEEDED',
        { retry_after: Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000) }
      );
    }

    // Helper to parse body as JSON or form-urlencoded
    async function parseRequestBody(request: Request): Promise<any> {
      const contentType = request.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        return await request.json();
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        const params = new URLSearchParams(text);
        const body: Record<string, any> = {};

        for (const [key, value] of params.entries()) {
          // Handle array fields (platforms, media_file_ids, account_ids, etc.)
          if (key === 'platforms' || key === 'media_file_ids' || key === 'account_ids' ||
            key === 'youtube_tags' || key === 'instagram_collaborators' ||
            key === 'youtube_allowed_countries' || key === 'youtube_blocked_countries') {
            // Try to parse as JSON array first, otherwise split by comma
            try {
              body[key] = JSON.parse(value);
            } catch {
              body[key] = value.split(',').map(s => s.trim()).filter(Boolean);
            }
          } else if (key === 'youtube_made_for_kids' || key === 'youtube_allow_embedding' ||
            key === 'youtube_public_stats_viewable' || key === 'youtube_contains_synthetic_media' ||
            key === 'youtube_has_paid_product_placement' || key === 'youtube_notify_subscribers' ||
            key === 'tiktok_allow_comments' ||
            key === 'tiktok_allow_duet' || key === 'tiktok_allow_stitch' ||
            key === 'tiktok_disclosure_content' || key === 'tiktok_brand_content' ||
            key === 'instagram_share_to_feed') {
            // Handle boolean fields
            body[key] = value === 'true' || value === '1';
          } else {
            body[key] = value;
          }
        }

        return body;
      } else if (contentType.includes('multipart/form-data')) {
        // Handle multipart form data
        const formData = await request.formData();
        const body: Record<string, any> = {};

        for (const [key, value] of formData.entries()) {
          if (typeof value === 'string') {
            // Handle array fields
            if (key === 'platforms' || key === 'media_file_ids' || key === 'account_ids' ||
              key === 'youtube_tags' || key === 'instagram_collaborators' ||
              key === 'youtube_allowed_countries' || key === 'youtube_blocked_countries') {
              try {
                body[key] = JSON.parse(value);
              } catch {
                body[key] = value.split(',').map(s => s.trim()).filter(Boolean);
              }
            } else if (key === 'youtube_made_for_kids' || key === 'youtube_allow_embedding' ||
              key === 'youtube_public_stats_viewable' || key === 'youtube_contains_synthetic_media' ||
              key === 'youtube_has_paid_product_placement' || key === 'youtube_notify_subscribers' ||
              key === 'tiktok_allow_comments' ||
              key === 'tiktok_allow_duet' || key === 'tiktok_allow_stitch' ||
              key === 'tiktok_disclosure_content' || key === 'tiktok_brand_content' ||
              key === 'instagram_share_to_feed') {
              body[key] = value === 'true' || value === '1';
            } else {
              body[key] = value;
            }
          }
        }

        return body;
      } else {
        // Try JSON as fallback
        try {
          return await request.json();
        } catch {
          // Try form-urlencoded as last resort
          const text = await request.text();
          const params = new URLSearchParams(text);
          const body: Record<string, any> = {};

          for (const [key, value] of params.entries()) {
            if (key === 'platforms' || key === 'media_file_ids' || key === 'account_ids') {
              try {
                body[key] = JSON.parse(value);
              } catch {
                body[key] = value.split(',').map(s => s.trim()).filter(Boolean);
              }
            } else {
              body[key] = value;
            }
          }

          return body;
        }
      }
    }

    // Route handling — wrap all responses with rate limit headers
    let response: Response;

    if (path === '/api/v1/post' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      console.log('Parsed request body:', JSON.stringify(body, null, 2));
      response = await handleCreatePost(req, supabaseAdmin, userId, body, userPreferredTimezone);
    } else if ((path === '/api/v1/upload-media' || path === '/api/v1/media/upload') && req.method === 'POST') {
      response = await handleUploadMedia(supabaseAdmin, userId, req);
    } else if (path === '/api/v1/accounts' && req.method === 'GET') {
      response = await handleGetAccounts(req, supabaseAdmin, userId, url);
    } else if (path === '/api/v1/posts' && req.method === 'GET') {
      response = await handleGetPosts(req, supabaseAdmin, userId, url);
    } else if (path.match(/^\/api\/v1\/post\/[^/]+$/) && req.method === 'GET') {
      const postId = path.replace('/api/v1/post/', '');
      response = await handleGetPostById(req, supabaseAdmin, userId, postId);
    } else if (path === '/api/v1/webhooks' && req.method === 'POST') {
      const body = await req.json();
      response = await handleRegisterWebhook(req, supabaseAdmin, userId, body);
    } else if (path === '/api/v1/webhooks' && req.method === 'GET') {
      response = await handleGetWebhooks(req, supabaseAdmin, userId);
    } else if (path === '/api/v1/webhooks/test' && req.method === 'POST') {
      const body = await req.json();
      response = await handleTestWebhook(req, supabaseAdmin, userId, body);
    } else if (path.startsWith('/api/v1/webhooks/') && req.method === 'DELETE') {
      const webhookId = path.replace('/api/v1/webhooks/', '');
      response = await handleDeleteWebhook(req, supabaseAdmin, userId, webhookId);
    } else if (path.match(/^\/api\/v1\/media\/[^/]+$/) && req.method === 'GET') {
      const mediaId = path.replace('/api/v1/media/', '');
      response = await handleGetMediaById(req, supabaseAdmin, userId, mediaId);
    } else {
      // 404 for unknown routes
      response = apiError(req, 'Not Found', 404, 'NOT_FOUND', {
        available_endpoints: [
          'POST /api/v1/post',
          'GET /api/v1/post/:id',
          'POST /api/v1/upload-media',
          'GET /api/v1/media/:id',
          'GET /api/v1/accounts',
          'GET /api/v1/posts',
          'POST /api/v1/webhooks',
          'GET /api/v1/webhooks',
          'DELETE /api/v1/webhooks/:id',
          'POST /api/v1/webhooks/test'
        ]
      });
    }

    return withRateLimitHeaders(response, rateLimit, path);

  } catch (error: unknown) {
    console.error('n8n API error:', error);
    return getSafeErrorResponse(error, 'Internal server error. Please try again.');
  }
});
