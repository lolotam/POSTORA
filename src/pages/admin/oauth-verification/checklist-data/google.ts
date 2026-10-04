import { Shield, Key, TestTube, FileText } from "lucide-react";
import { ChecklistItem, CategoryInfo } from "../types";

export const googleChecklistItems: ChecklistItem[] = [
  // Privacy Policy Requirements
  {
    id: "privacy_policy",
    title: "Privacy Policy Published",
    description: "A comprehensive privacy policy explaining how user data is collected, used, and protected.",
    category: "privacy",
    internalLink: "/privacy",
    required: true,
  },
  {
    id: "google_disclosure",
    title: "Google API Disclosure Page",
    description: "Dedicated page explaining Google API usage, scopes, and Limited Use compliance.",
    category: "privacy",
    internalLink: "/google-api-disclosure",
    required: true,
  },
  {
    id: "youtube_tos_link",
    title: "YouTube Terms of Service Link",
    description: "Link to YouTube ToS in privacy policy and/or disclosure page.",
    category: "privacy",
    link: "https://www.youtube.com/t/terms",
    required: true,
  },
  {
    id: "google_privacy_link",
    title: "Google Privacy Policy Link",
    description: "Link to Google Privacy Policy in disclosure documents.",
    category: "privacy",
    link: "https://policies.google.com/privacy",
    required: true,
  },
  {
    id: "data_deletion",
    title: "Data Deletion Instructions",
    description: "Clear instructions for users on how to revoke access and delete their data.",
    category: "privacy",
    required: true,
  },
  {
    id: "limited_use",
    title: "Limited Use Disclosure",
    description: "Statement confirming adherence to Google API Services User Data Policy Limited Use requirements.",
    category: "privacy",
    link: "https://developers.google.com/terms/api-services-user-data-policy",
    required: true,
  },
  // Scope Justification
  {
    id: "scope_youtube_upload",
    title: "youtube.upload Scope Justification",
    description: "Sensitive scope (https://www.googleapis.com/auth/youtube.upload) used to upload user-created videos and Shorts to the user's own channel with the title, description, tags, category, and privacy setting they chose in Postora, and to set the custom thumbnail on the just-uploaded video (thumbnails.set).",
    category: "scopes",
    required: true,
  },
  {
    id: "scope_youtube_readonly",
    title: "youtube.readonly Scope Justification",
    description: "Sensitive scope (https://www.googleapis.com/auth/youtube.readonly) used at connection time to read the user's channel name, ID, and avatar (channels.list mine=true) so the user can confirm the correct channel, and to periodically verify the connection is still healthy.",
    category: "scopes",
    required: true,
  },
  {
    id: "scope_youtube_force_ssl",
    title: "youtube.force-ssl Scope Justification",
    description: "Sensitive scope (https://www.googleapis.com/auth/youtube.force-ssl) used to read comments on the user's own videos (commentThreads.list), reply to them (comments.insert), hide or unhide them (comments.setModerationStatus) and delete the user's own comments (comments.delete) from Postora's Comment Manager, auto-reply rules and AI agent — all on the user's own channel only.",
    category: "scopes",
    required: true,
  },
  {
    id: "minimum_scopes",
    title: "Minimum Scopes Principle",
    description: "Exactly three narrow YouTube scopes requested (youtube.readonly, youtube.upload, youtube.force-ssl) — matching the OAuth request in code byte-for-byte. The broad youtube scope is intentionally not requested.",
    category: "scopes",
    link: "https://support.google.com/cloud/answer/13807380",
    required: true,
  },
  // Testing Requirements
  {
    id: "test_credentials",
    title: "Test Account Credentials",
    description: "Prepare test account credentials for Google verification team (disable 2FA on test account).",
    category: "testing",
    link: "https://support.google.com/cloud/answer/13807382",
    required: true,
  },
  {
    id: "test_instructions",
    title: "OAuth Flow Test Instructions",
    description: "Step-by-step instructions for Google team to test the YouTube connection flow.",
    category: "testing",
    required: true,
  },
  {
    id: "staging_environment",
    title: "Staging Environment (if needed)",
    description: "Separate Cloud Console project for testing if production app is live.",
    category: "testing",
    required: false,
  },
  // Documentation
  {
    id: "cloud_console_config",
    title: "OAuth Consent Screen Configured",
    description: "OAuth consent screen in Google Cloud Console with app name, logo, and authorized domains.",
    category: "documentation",
    link: "https://console.cloud.google.com/apis/credentials/consent",
    required: true,
  },
  {
    id: "authorized_domains",
    title: "Authorized Domains Added",
    description: "Your Supabase project domain and app domain added to authorized domains.",
    category: "documentation",
    required: true,
  },
  {
    id: "app_homepage",
    title: "Application Homepage URL",
    description: "Valid homepage URL provided in OAuth consent screen.",
    category: "documentation",
    required: true,
  },
  {
    id: "support_email",
    title: "Support Email Configured",
    description: "Valid support email address configured in OAuth consent screen.",
    category: "documentation",
    required: true,
  },
];

export const googleCategoryInfo: Record<string, CategoryInfo> = {
  privacy: { label: "Privacy & Policy", icon: Shield, color: "text-blue-500" },
  scopes: { label: "Scope Justification", icon: Key, color: "text-foreground" },
  testing: { label: "In-App Testing", icon: TestTube, color: "text-orange-500" },
  documentation: { label: "Cloud Console Setup", icon: FileText, color: "text-green-500" },
};
