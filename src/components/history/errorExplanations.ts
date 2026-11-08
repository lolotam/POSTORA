export interface ErrorExplanation {
  title: string;
  explanation: string;
  recommendation: string;
  icon: "size" | "auth" | "rate" | "format" | "network" | "permission";
}

interface ErrorPattern {
  pattern: RegExp;
  platform?: string;
  result: ErrorExplanation;
}

const errorPatterns: ErrorPattern[] = [
  {
    pattern: /^story_worker_gave_up$/,
    platform: "instagram",
    result: {
      title: "Story processing stopped",
      explanation: "The worker stopped before dispatching the Story. The published Reel is unchanged.",
      recommendation: "Use the Story result's Retry button to start a new attempt.",
      icon: "network",
    },
  },
  {
    pattern: /^story_media_not_eligible$/,
    platform: "instagram",
    result: {
      title: "Story media needs attention",
      explanation: "The separate Story copy could not pass the media checks. The published Reel is unchanged.",
      recommendation: "Use a vertical JPEG up to 8 MB, or MP4/MOV up to 100 MB and 3–60 seconds. Dimensions and video duration must be available in the media library. Nothing is trimmed automatically.",
      icon: "format",
    },
  },
  {
    pattern: /^story_account_not_eligible$/,
    platform: "instagram",
    result: {
      title: "Story publishing unavailable",
      explanation: "Postora could not verify a Business account with Story publishing permission for this connection.",
      recommendation: "Check the account's connection and publishing permissions. The published Reel is unchanged.",
      icon: "permission",
    },
  },
  {
    pattern: /^story_(publish_unconfirmed|worker_exhausted)$/,
    platform: "instagram",
    result: {
      title: "Story outcome needs verification",
      explanation: "The Story worker could not confirm the final result. The Reel is a separate publication.",
      recommendation: "Check Instagram and the Story status before taking another action. Do not create another copy while its outcome is uncertain.",
      icon: "network",
    },
  },
  // ── Bluesky ──
  {
    pattern: /blob too big/i,
    platform: "bluesky",
    result: {
      title: "Image Too Large",
      explanation: "Your image exceeds Bluesky's 1MB file size limit. Bluesky only accepts images under 1MB each.",
      recommendation: "Use a smaller image or upload through Postora's media library — Cloudinary-hosted images are automatically compressed before uploading to Bluesky.",
      icon: "size",
    },
  },
  {
    pattern: /OAuth tokens are meant for PDS/i,
    platform: "bluesky",
    result: {
      title: "Authentication Issue",
      explanation: "Your Bluesky account connection needs to be updated. The current tokens are not configured for your personal data server.",
      recommendation: "Go to Profiles page, disconnect your Bluesky account, and reconnect it. This will refresh your authentication.",
      icon: "auth",
    },
  },
  {
    pattern: /DPoP nonce/i,
    platform: "bluesky",
    result: {
      title: "Temporary Auth Error",
      explanation: "A temporary authentication timing issue occurred with Bluesky's security system.",
      recommendation: "Simply retry posting — this error usually resolves automatically on the next attempt.",
      icon: "auth",
    },
  },
  {
    pattern: /Invalid.*record/i,
    platform: "bluesky",
    result: {
      title: "Invalid Post Format",
      explanation: "The post content doesn't meet Bluesky's format requirements. This can happen if the text is too long or the media format is unsupported.",
      recommendation: "Check that your text is under 300 characters. For images, use JPEG, PNG, or WebP (max 4 images, each under 1MB). For video, use MP4 (max 50MB, 60 seconds).",
      icon: "format",
    },
  },
  {
    pattern: /still exceeds.*1MB/i,
    result: {
      title: "Image Compression Failed",
      explanation: "Postora tried to automatically compress your image but it's still larger than Bluesky's 1MB limit even at maximum compression.",
      recommendation: "Please upload a smaller image (reduce resolution or use JPEG format). Images larger than ~5MB before compression may not compress enough.",
      icon: "size",
    },
  },

  // ── Generic (all platforms) ──
  {
    pattern: /rate.?limit/i,
    result: {
      title: "Too Many Requests",
      explanation: "You've sent too many requests in a short period. The platform is temporarily limiting your activity.",
      recommendation: "Wait a few minutes before trying again. Avoid posting too rapidly to the same platform.",
      icon: "rate",
    },
  },
  {
    pattern: /token.*expired|access.*token.*invalid|unauthorized/i,
    result: {
      title: "Account Connection Expired",
      explanation: "Your account connection has expired or become invalid. This happens when tokens expire or permissions change.",
      recommendation: "Go to the Profiles page and reconnect the affected account to refresh your authentication.",
      icon: "auth",
    },
  },
  {
    pattern: /permission|insufficient.*scope/i,
    result: {
      title: "Missing Permissions",
      explanation: "Your connected account doesn't have the required permissions to perform this action.",
      recommendation: "Reconnect your account in the Profiles page and make sure to grant all requested permissions during the authorization process.",
      icon: "permission",
    },
  },
  {
    pattern: /network|fetch|ECONNREFUSED|timeout|ETIMEDOUT/i,
    result: {
      title: "Connection Error",
      explanation: "A network error occurred while communicating with the platform's servers. This could be a temporary outage.",
      recommendation: "Check your internet connection and try again. If the problem persists, the platform may be experiencing temporary issues.",
      icon: "network",
    },
  },
  {
    pattern: /duplicate|already.*posted|already.*exists/i,
    result: {
      title: "Duplicate Content",
      explanation: "The platform detected this content has already been posted or is too similar to a recent post.",
      recommendation: "Modify your caption or media slightly before posting again. Most platforms have anti-spam measures that block identical content.",
      icon: "format",
    },
  },
  {
    pattern: /media.*type.*not.*supported|unsupported.*format|invalid.*media/i,
    result: {
      title: "Unsupported Media Format",
      explanation: "The media file format is not supported by this platform.",
      recommendation: "Use JPEG or PNG for images, and MP4 for videos. Convert your media to a supported format before uploading.",
      icon: "format",
    },
  },
  {
    pattern: /file.*too.*large|payload.*too.*large|entity.*too.*large/i,
    result: {
      title: "File Too Large",
      explanation: "The uploaded file exceeds the platform's maximum file size limit.",
      recommendation: "Reduce the file size by compressing the image or video, or use a lower resolution version.",
      icon: "size",
    },
  },

  // ── TikTok ──
  {
    pattern: /sandbox|spam.*risk/i,
    platform: "tiktok",
    result: {
      title: "TikTok Sandbox Restriction",
      explanation: "Your TikTok developer app may be in sandbox mode, which restricts posting capabilities.",
      recommendation: "Contact Postora support or check your TikTok developer app status. Production apps require TikTok approval.",
      icon: "permission",
    },
  },
  {
    pattern: /privacy.*level|disclosure/i,
    platform: "tiktok",
    result: {
      title: "Missing TikTok Settings",
      explanation: "TikTok requires privacy level and content disclosure settings for every post.",
      recommendation: "Make sure to select a privacy level and complete the content disclosure section in TikTok settings before posting.",
      icon: "format",
    },
  },

  // ── Instagram ──
  {
    pattern: /carousel.*minimum|at least 2/i,
    platform: "instagram",
    result: {
      title: "Not Enough Images for Carousel",
      explanation: "Instagram carousels require at least 2 images. You only provided 1 image.",
      recommendation: "Add more images to create a carousel, or post as a single image instead.",
      icon: "format",
    },
  },

  // ── Facebook ──
  {
    pattern: /page.*access.*token|page_id/i,
    platform: "facebook",
    result: {
      title: "Facebook Page Access Issue",
      explanation: "There's an issue accessing your Facebook Page. The page token may be expired or the page may no longer be available.",
      recommendation: "Reconnect your Facebook account in the Profiles page and reselect the page you want to post to.",
      icon: "auth",
    },
  },
];

export function getErrorExplanation(
  errorMessage: string | null | undefined,
  platform?: string
): ErrorExplanation | null {
  if (!errorMessage) return null;

  // Try platform-specific patterns first
  if (platform) {
    for (const entry of errorPatterns) {
      if (entry.platform === platform && entry.pattern.test(errorMessage)) {
        return entry.result;
      }
    }
  }

  // Then try generic patterns
  for (const entry of errorPatterns) {
    if (!entry.platform && entry.pattern.test(errorMessage)) {
      return entry.result;
    }
  }

  return null;
}
