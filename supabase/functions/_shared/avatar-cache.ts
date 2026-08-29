/**
 * Avatar Caching Helper
 * 
 * Caches social media profile avatars to Cloudinary so they never expire.
 * Platform CDN URLs (Facebook, Instagram, TikTok) typically expire after hours/days.
 * By uploading to Cloudinary, we get permanent URLs.
 */

interface CloudinaryUploadResult {
  success: boolean;
  url?: string;
  publicId?: string;
  error?: string;
}

/**
 * Uploads an avatar image from a source URL to Cloudinary
 * @param sourceUrl - The temporary CDN URL from the social platform
 * @param userId - The Postora user ID
 * @param platform - The social platform (facebook, instagram, tiktok, etc.)
 * @param platformUserId - The platform-specific user/page ID
 * @returns The permanent Cloudinary URL or null if caching fails
 */
export async function cacheAvatarToCloudinary(
  sourceUrl: string | null | undefined,
  userId: string,
  platform: string,
  platformUserId: string
): Promise<string | null> {
  if (!sourceUrl) {
    console.log(`[avatar-cache] No source URL provided for ${platform}/${platformUserId}`);
    return null;
  }

  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

  if (!cloudName || !apiKey || !apiSecret) {
    console.warn("[avatar-cache] Cloudinary credentials not configured, skipping avatar caching");
    return sourceUrl; // Return original URL as fallback
  }

  try {
    console.log(`[avatar-cache] Caching avatar for ${platform}/${platformUserId}`);

    // Create a consistent public ID for this avatar
    // Format: avatars/{userId}/{platform}_{platformUserId}
    const folder = `avatars/${userId}`;
    const publicId = `${platform}_${platformUserId}`;
    const timestamp = Math.floor(Date.now() / 1000);

    // Build signature
    const signatureParams = [
      `folder=${folder}`,
      `overwrite=true`,
      `public_id=${publicId}`,
      `timestamp=${timestamp}`,
    ].sort().join("&");

    // Create SHA-1 signature
    const encoder = new TextEncoder();
    const data = encoder.encode(signatureParams + apiSecret);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    // Upload to Cloudinary using the source URL
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

    const formData = new FormData();
    formData.append("file", sourceUrl); // Cloudinary accepts URLs directly
    formData.append("api_key", apiKey);
    formData.append("timestamp", timestamp.toString());
    formData.append("signature", signature);
    formData.append("folder", folder);
    formData.append("public_id", publicId);
    formData.append("overwrite", "true");

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(8_000),
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error(`[avatar-cache] Cloudinary upload failed: ${errorText}`);
      return sourceUrl; // Return original URL as fallback
    }

    const result = await uploadResponse.json();
    console.log(`[avatar-cache] Avatar cached successfully: ${result.secure_url}`);
    
    return result.secure_url;
  } catch (error) {
    // Log error.name only: Deno embeds full request URLs in network error messages, and
    // the fetchers below carry live access tokens in those URLs.
    console.error(`[avatar-cache] Error caching avatar:`, error instanceof Error ? error.name : "UnknownError");
    return sourceUrl; // Return original URL as fallback
  }
}

/**
 * Platform-specific avatar URL fetchers
 * Used during token refresh to get fresh avatar URLs
 */

export async function fetchFacebookAvatarUrl(accessToken: string, pageId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${pageId}/picture?redirect=false&type=large&access_token=${accessToken}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = await response.json();
    return data.data?.url || null;
  } catch (error) {
    // The token is in the URL and Deno embeds the URL in network errors — name only.
    console.error("[avatar-cache] Error fetching Facebook avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchInstagramAvatarUrl(accessToken: string, igUserId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${igUserId}?fields=profile_picture_url&access_token=${accessToken}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = await response.json();
    return data.profile_picture_url || null;
  } catch (error) {
    // The token is in the URL and Deno embeds the URL in network errors — name only.
    console.error("[avatar-cache] Error fetching Instagram avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchTikTokAvatarUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=avatar_url",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    return data.data?.user?.avatar_url || null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching TikTok avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchTwitterAvatarUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      "https://api.twitter.com/2/users/me?user.fields=profile_image_url",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    // Get the original size by replacing _normal suffix
    const url = data.data?.profile_image_url;
    return url ? url.replace("_normal", "") : null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching Twitter avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchLinkedInAvatarUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      "https://api.linkedin.com/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    return data.picture || null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching LinkedIn avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchPinterestAvatarUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      "https://api.pinterest.com/v5/user_account",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    return data.profile_image || null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching Pinterest avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchYouTubeAvatarUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    const thumbnails = data.items?.[0]?.snippet?.thumbnails;
    return thumbnails?.high?.url || thumbnails?.medium?.url || thumbnails?.default?.url || null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching YouTube avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchThreadsAvatarUrl(accessToken: string, userId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://graph.threads.net/v1.0/${userId}?fields=threads_profile_picture_url&access_token=${accessToken}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = await response.json();
    return data.threads_profile_picture_url || null;
  } catch (error) {
    // The token is in the URL and Deno embeds the URL in network errors — name only.
    console.error("[avatar-cache] Error fetching Threads avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchBlueskyAvatarUrl(accessToken: string, handle: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    return data.avatar || null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching Bluesky avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function fetchRedditAvatarUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      "https://oauth.reddit.com/api/v1/me",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "Postora/1.0",
        },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await response.json();
    return data.icon_img?.split("?")[0] || data.snoovatar_img || null;
  } catch (error) {
    console.error("[avatar-cache] Error fetching Reddit avatar:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
