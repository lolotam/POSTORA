import { Settings, Key, FileText, Shield } from "lucide-react";
import { ChecklistItem, CategoryInfo } from "../types";

export const blueskyChecklistItems: ChecklistItem[] = [
  // App Setup
  {
    id: "bluesky_app_password",
    title: "App Password or OAuth Setup",
    description: "Use App Passwords or AT Protocol OAuth for authentication.",
    category: "setup",
    link: "https://bsky.app/settings/app-passwords",
    required: true,
  },
  {
    id: "bluesky_pds_endpoint",
    title: "PDS Endpoint Configuration",
    description: "Configure Personal Data Server endpoint (default: bsky.social).",
    category: "setup",
    link: "https://atproto.com/guides/applications",
    required: true,
  },
  {
    id: "bluesky_handle_resolution",
    title: "Handle Resolution",
    description: "Implement handle-to-DID resolution for user identification.",
    category: "setup",
    required: true,
  },
  {
    id: "bluesky_session_management",
    title: "Session Token Management",
    description: "Properly store and refresh access/refresh JWT tokens.",
    category: "setup",
    required: true,
  },
  // API Integration
  {
    id: "bluesky_create_record",
    title: "com.atproto.repo.createRecord",
    description: "Use createRecord endpoint for posting content.",
    category: "api",
    link: "https://docs.bsky.app/docs/api/com-atproto-repo-create-record",
    required: true,
  },
  {
    id: "bluesky_upload_blob",
    title: "com.atproto.repo.uploadBlob",
    description: "Use uploadBlob for image attachments before posting.",
    category: "api",
    link: "https://docs.bsky.app/docs/api/com-atproto-repo-upload-blob",
    required: true,
  },
  {
    id: "bluesky_rich_text",
    title: "Rich Text Facets",
    description: "Parse and encode mentions, links, and hashtags as facets.",
    category: "api",
    link: "https://docs.bsky.app/docs/advanced-guides/post-richtext",
    required: true,
  },
  // Content Requirements
  {
    id: "bluesky_text_limits",
    title: "Post Character Limits",
    description: "Posts limited to 300 graphemes (not characters).",
    category: "content",
    required: true,
  },
  {
    id: "bluesky_image_specs",
    title: "Image Specifications",
    description: "Images: max 1MB per image, up to 4 images per post.",
    category: "content",
    required: true,
  },
  {
    id: "bluesky_alt_text",
    title: "Image Alt Text Support",
    description: "Support alt text for images (accessibility requirement).",
    category: "content",
    required: true,
  },
  {
    id: "bluesky_link_cards",
    title: "External Link Cards",
    description: "Support for external embed cards with link previews.",
    category: "content",
    link: "https://docs.bsky.app/docs/advanced-guides/posts#website-card-embeds",
    required: false,
  },
  // Compliance
  {
    id: "bluesky_community_guidelines",
    title: "Bluesky Community Guidelines",
    description: "Ensure content complies with Bluesky Community Guidelines.",
    category: "compliance",
    link: "https://bsky.social/about/support/community-guidelines",
    required: true,
  },
  {
    id: "bluesky_rate_limits",
    title: "Rate Limit Handling",
    description: "Handle rate limits gracefully with exponential backoff.",
    category: "compliance",
    required: true,
  },
  {
    id: "bluesky_terms",
    title: "Bluesky Terms of Service",
    description: "Application complies with Bluesky Terms of Service.",
    category: "compliance",
    link: "https://bsky.social/about/support/tos",
    required: true,
  },
  {
    id: "bluesky_atproto_spec",
    title: "AT Protocol Specification",
    description: "Follow AT Protocol specification for interoperability.",
    category: "compliance",
    link: "https://atproto.com/specs/atp",
    required: false,
  },
];

export const blueskyCategoryInfo: Record<string, CategoryInfo> = {
  setup: { label: "App Setup", icon: Settings, color: "text-blue-500" },
  api: { label: "API Integration", icon: Key, color: "text-cyan-500" },
  content: { label: "Content Requirements", icon: FileText, color: "text-foreground" },
  compliance: { label: "Compliance", icon: Shield, color: "text-green-500" },
};
