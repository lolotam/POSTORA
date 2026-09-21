/**
 * Avatar Caching Helper
 *
 * Platform CDN URLs expire: Meta signs them and they start returning 403 within
 * days, which is why avatars are re-hosted rather than linked.
 *
 * This used to upload to Cloudinary. That account was disabled, so every URL it
 * had ever written began returning 401 and the UI silently fell back to a
 * generic platform glyph everywhere an account avatar should appear. Uploads now
 * go to Openinary, which is the only image host this project still runs.
 */
import {
  getOpeninaryConfig,
  openinaryTarget,
  uploadToOpeninary,
  deleteFromOpeninary,
} from "./openinary.ts";

/**
 * Re-hosts an avatar and returns a permanent URL.
 *
 * Returns the source URL unchanged when Openinary is not configured or the
 * upload fails: a stale avatar beats losing the account row's only picture, and
 * every caller writes the result straight into social_accounts.avatar_url.
 *
 * @param sourceUrl       short-lived CDN URL from the platform
 * @param userId          Postora user id, used to scope the stored path
 * @param platform        facebook, instagram, tiktok, ...
 * @param platformUserId  platform-side page/user id
 */
export async function cacheAvatarToCdn(
  sourceUrl: string | null | undefined,
  userId: string,
  platform: string,
  platformUserId: string
): Promise<string | null> {
  if (!sourceUrl) return null;

  const config = getOpeninaryConfig();
  if (!config) {
    console.warn("[avatar-cache] Openinary not configured, leaving the source URL in place");
    return sourceUrl;
  }

  // Same path scheme the Cloudinary version used, so a re-run overwrites in
  // place rather than scattering a second copy per account.
  const { folder, baseName } = openinaryTarget(
    `avatars/${userId}/${platform}_${platformUserId}`,
    config.folderPrefix
  );

  try {
    // No requiredExtension: the helper sniffs it from the response content type.
    // Forcing one 400s whenever a platform serves webp where we assumed jpg.
    let result = await uploadToOpeninary(config, sourceUrl, folder, baseName);

    // Openinary treats an existing path with different bytes as a collision and
    // renames it, which the helper reports as failure because the renamed path
    // is unreachable by the deterministic read URL. An avatar legitimately
    // changes, so clear the old object and store the new one once.
    if (!result.success && result.error?.includes("collision rename")) {
      if (result.path) await deleteFromOpeninary(config, result.path);
      await deleteFromOpeninary(config, `${folder}/${baseName}.jpg`);
      await deleteFromOpeninary(config, `${folder}/${baseName}.png`);
      await deleteFromOpeninary(config, `${folder}/${baseName}.webp`);
      result = await uploadToOpeninary(config, sourceUrl, folder, baseName);
    }

    if (!result.success || !result.url) {
      console.error(`[avatar-cache] Upload failed for ${platform}/${platformUserId}: ${result.error}`);
      return sourceUrl;
    }
    return result.url;
  } catch (error) {
    // error.name only: Deno puts the full request URL in network error messages,
    // and the fetchers below carry live access tokens in theirs.
    console.error("[avatar-cache] Error caching avatar:", error instanceof Error ? error.name : "UnknownError");
    return sourceUrl;
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
    // Two connection flavours land in this column. Instagram Login mints `IGA…`
    // tokens that only graph.instagram.com accepts, and which address their own
    // owner as `me` rather than by id. Instagram Business via Facebook Login
    // mints `EAA…` tokens that graph.facebook.com accepts against the IG user
    // id. Sending either to the other host returns OAuthException 190,
    // "Cannot parse access token" — which this helper used to swallow as
    // "account has no avatar", so every Instagram-Login account silently kept
    // its dead picture.
    const url = accessToken.startsWith("IGA")
      ? `https://graph.instagram.com/v21.0/me?fields=profile_picture_url&access_token=${accessToken}`
      : `https://graph.facebook.com/v18.0/${igUserId}?fields=profile_picture_url&access_token=${accessToken}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const data = await response.json();
    if (data.error) {
      console.error(
        `[avatar-cache] Instagram avatar fetch rejected for ${igUserId}: ${data.error.type} ${data.error.code}`
      );
      return null;
    }
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
