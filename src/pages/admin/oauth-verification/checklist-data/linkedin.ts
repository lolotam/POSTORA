import { Settings, Key, FileText, Shield } from "lucide-react";
import { ChecklistItem, CategoryInfo } from "../types";

export const linkedinChecklistItems: ChecklistItem[] = [
  // App Setup
  {
    id: "linkedin_dev_app",
    title: "LinkedIn Developer App Created",
    description: "Application registered in LinkedIn Developer Portal with correct products.",
    category: "setup",
    link: "https://www.linkedin.com/developers/apps",
    required: true,
  },
  {
    id: "linkedin_client_credentials",
    title: "Client ID and Secret Configured",
    description: "LinkedIn Client ID and Client Secret stored securely in environment variables.",
    category: "setup",
    required: true,
  },
  {
    id: "linkedin_redirect_uri",
    title: "OAuth 2.0 Redirect URL Configured",
    description: "Authorized redirect URL added in LinkedIn app settings (must be HTTPS).",
    category: "setup",
    required: true,
  },
  {
    id: "linkedin_products_enabled",
    title: "Required Products Enabled",
    description: "Sign In with LinkedIn using OpenID Connect and Share on LinkedIn products enabled.",
    category: "setup",
    link: "https://www.linkedin.com/developers/apps",
    required: true,
  },
  // Scopes & Permissions
  {
    id: "linkedin_openid_scope",
    title: "openid Scope (OIDC)",
    description: "Required for OpenID Connect authentication flow.",
    category: "scopes",
    required: true,
  },
  {
    id: "linkedin_profile_scope",
    title: "profile Scope",
    description: "Access to basic profile information (name, profile picture).",
    category: "scopes",
    required: true,
  },
  {
    id: "linkedin_email_scope",
    title: "email Scope",
    description: "Access to user's email address.",
    category: "scopes",
    required: true,
  },
  {
    id: "linkedin_w_member_social",
    title: "w_member_social Scope",
    description: "Permission to post content on behalf of the user.",
    category: "scopes",
    link: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
    required: true,
  },
  // Content Requirements
  {
    id: "linkedin_post_format",
    title: "Post Format Compliance",
    description: "Text posts support up to 3000 characters, images up to 5MB.",
    category: "content",
    required: true,
  },
  {
    id: "linkedin_image_specs",
    title: "Image Specifications",
    description: "Images must be JPEG, PNG, or GIF format with max 5MB size.",
    category: "content",
    link: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api",
    required: true,
  },
  {
    id: "linkedin_video_specs",
    title: "Video Specifications",
    description: "Videos: MP4 format, 75KB-200MB, 3 sec - 10 min duration.",
    category: "content",
    link: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api",
    required: false,
  },
  {
    id: "linkedin_visibility_control",
    title: "Visibility Control",
    description: "Allow users to choose post visibility (public, connections only).",
    category: "content",
    required: true,
  },
  // Compliance & Documentation
  {
    id: "linkedin_privacy_policy",
    title: "Privacy Policy URL",
    description: "Privacy policy URL added to LinkedIn developer app settings.",
    category: "compliance",
    internalLink: "/privacy",
    required: true,
  },
  {
    id: "linkedin_tos_url",
    title: "Terms of Service URL",
    description: "Terms of service URL configured in app settings.",
    category: "compliance",
    internalLink: "/terms",
    required: true,
  },
  {
    id: "linkedin_api_tos",
    title: "LinkedIn API Terms of Use",
    description: "Application complies with LinkedIn API Terms of Use.",
    category: "compliance",
    link: "https://www.linkedin.com/legal/l/api-terms-of-use",
    required: true,
  },
  {
    id: "linkedin_branding",
    title: "LinkedIn Brand Guidelines",
    description: "Sign in button and UI follows LinkedIn brand guidelines.",
    category: "compliance",
    link: "https://brand.linkedin.com/",
    required: false,
  },
  {
    id: "linkedin_rate_limits",
    title: "Rate Limit Handling",
    description: "Proper handling of API rate limits (default 100 requests/day for Share API).",
    category: "compliance",
    required: true,
  },
  {
    id: "linkedin_app_review",
    title: "App Review (if needed)",
    description: "Submit app for LinkedIn review if requesting additional permissions.",
    category: "compliance",
    link: "https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/permissions",
    required: false,
  },
];

export const linkedinCategoryInfo: Record<string, CategoryInfo> = {
  setup: { label: "App Setup", icon: Settings, color: "text-blue-600" },
  scopes: { label: "Scopes & Permissions", icon: Key, color: "text-foreground" },
  content: { label: "Content Requirements", icon: FileText, color: "text-cyan-500" },
  compliance: { label: "Compliance & Documentation", icon: Shield, color: "text-green-500" },
};
