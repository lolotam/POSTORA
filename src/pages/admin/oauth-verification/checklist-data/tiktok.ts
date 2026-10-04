import { Key, Shield, Video, FileText } from "lucide-react";
import { ChecklistItem, CategoryInfo } from "../types";

export const tiktokChecklistItems: ChecklistItem[] = [
  // API Integration
  {
    id: "tiktok_creator_info",
    title: "Call creator_info API Before Each Post",
    description: "Always fetch creator settings and permissions before initiating a post.",
    category: "api",
    link: "https://developers.tiktok.com/doc/tiktok-api-v2-get-creator-info/",
    required: true,
  },
  {
    id: "tiktok_display_nickname",
    title: "Display Creator's Nickname on Posting Page",
    description: "Show the creator's TikTok nickname prominently on the post creation interface.",
    category: "api",
    required: true,
  },
  {
    id: "tiktok_post_status_tracking",
    title: "Track Post Status via API",
    description: "Monitor post processing status using publish status endpoint after submission.",
    category: "api",
    link: "https://developers.tiktok.com/doc/tiktok-api-v2-post-publish-status-fetch/",
    required: true,
  },
  {
    id: "tiktok_domain_verification",
    title: "Domain Ownership Verification (PULL_FROM_URL)",
    description: "Verify domain ownership if using PULL_FROM_URL upload method.",
    category: "api",
    required: false,
  },
  // Privacy & Settings
  {
    id: "tiktok_no_default_privacy",
    title: "No Default Values for Privacy Settings",
    description: "Privacy level must be explicitly chosen by the creator - no pre-selected defaults.",
    category: "privacy",
    required: true,
  },
  {
    id: "tiktok_no_default_interactions",
    title: "No Default Values for Interaction Settings",
    description: "Comments, Duet, Stitch toggles must be explicitly set by creator.",
    category: "privacy",
    required: true,
  },
  {
    id: "tiktok_respect_max_duration",
    title: "Respect max_video_post_duration_sec",
    description: "Validate video duration against creator's maximum allowed duration.",
    category: "privacy",
    required: true,
  },
  {
    id: "tiktok_brand_disclosure",
    title: "Brand Content & Organic Disclosure Toggles",
    description: "Provide clear toggles for branded content and organic disclosure options.",
    category: "privacy",
    required: true,
  },
  // Content Requirements
  {
    id: "tiktok_music_acknowledgment",
    title: "Music Usage Acknowledgment",
    description: "Display acknowledgment about music usage and potential copyright implications.",
    category: "content",
    required: true,
  },
  {
    id: "tiktok_content_preview",
    title: "Content Preview Before Posting",
    description: "Show full content preview before final submission to TikTok.",
    category: "content",
    required: true,
  },
  {
    id: "tiktok_no_watermarks",
    title: "No Promotional Watermarks",
    description: "Ensure uploaded content doesn't contain promotional watermarks.",
    category: "content",
    required: true,
  },
  {
    id: "tiktok_video_format",
    title: "Video Format Compliance",
    description: "Videos must meet TikTok's aspect ratio and format requirements.",
    category: "content",
    link: "https://developers.tiktok.com/doc/content-sharing-guidelines/",
    required: true,
  },
  // Documentation
  {
    id: "tiktok_dev_portal_app",
    title: "TikTok Developer Portal App Created",
    description: "Application registered in TikTok Developer Portal with correct scopes.",
    category: "documentation",
    link: "https://developers.tiktok.com/",
    required: true,
  },
  {
    id: "tiktok_redirect_uri",
    title: "Redirect URI Configured",
    description: "OAuth redirect URI properly configured in TikTok app settings.",
    category: "documentation",
    required: true,
  },
  {
    id: "tiktok_privacy_policy",
    title: "Privacy Policy URL in App",
    description: "Privacy policy URL added to TikTok developer app settings.",
    category: "documentation",
    internalLink: "/privacy",
    required: true,
  },
  {
    id: "tiktok_tos_url",
    title: "Terms of Service URL in App",
    description: "Terms of service URL added to TikTok developer app settings.",
    category: "documentation",
    internalLink: "/terms",
    required: true,
  },
];

export const tiktokCategoryInfo: Record<string, CategoryInfo> = {
  api: { label: "API Integration", icon: Key, color: "text-cyan-500" },
  privacy: { label: "Privacy & Settings", icon: Shield, color: "text-blue-500" },
  content: { label: "Content Requirements", icon: Video, color: "text-foreground" },
  documentation: { label: "App Configuration", icon: FileText, color: "text-green-500" },
};
