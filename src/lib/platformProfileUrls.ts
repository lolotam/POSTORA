import { Platform } from "@/lib/types";

/**
 * Generates the public profile URL for a given platform and account
 */
export function getPlatformProfileUrl(
  platform: Platform,
  platformUsername: string | null,
  platformUserId?: string | null,
  accountMetadata?: Record<string, unknown> | null
): string | null {
  if (!platformUsername && !platformUserId) return null;

  const username = platformUsername || "";
  const userId = platformUserId || "";

  switch (platform) {
    case "facebook":
      // Facebook uses profile ID for the URL
      return userId ? `https://www.facebook.com/profile.php?id=${userId}` : null;
    
    case "instagram":
      return username ? `https://www.instagram.com/${username.replace("@", "")}` : null;
    
    case "tiktok":
      return username ? `https://www.tiktok.com/@${username.replace("@", "")}` : null;
    
    case "youtube":
      // YouTube channel can be accessed via @handle
      return username ? `https://www.youtube.com/@${username.replace("@", "")}` : null;
    
    case "twitter":
      return username ? `https://x.com/${username.replace("@", "")}` : null;
    
    case "linkedin":
      // LinkedIn's OpenID Connect scopes don't expose vanityName,
      // so we cannot construct a reliable profile URL
      return null;
    
    case "threads":
      return username ? `https://www.threads.net/@${username.replace("@", "")}` : null;
    
    case "bluesky": {
      // Bluesky handles are typically like handle.bsky.social
      const blueskyHandle = username.replace("@", "");
      return `https://bsky.app/profile/${blueskyHandle}`;
    }
    
    case "pinterest":
      return username ? `https://www.pinterest.com/${username.replace("@", "")}` : null;
    
    case "reddit":
      return username ? `https://www.reddit.com/user/${username.replace("u/", "")}` : null;
    
    default:
      return null;
  }
}
