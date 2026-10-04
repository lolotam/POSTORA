import { Settings, Key, Image, Shield } from "lucide-react";
import { ChecklistItem, CategoryInfo } from "../types";

export const pinterestChecklistItems: ChecklistItem[] = [
  // App Setup
  {
    id: "pinterest_dev_app",
    title: "Pinterest Developer App Created",
    description: "Application registered in Pinterest Developer Portal with correct permissions.",
    category: "setup",
    link: "https://developers.pinterest.com/apps/",
    required: true,
  },
  {
    id: "pinterest_app_id_secret",
    title: "App ID and Secret Configured",
    description: "Pinterest App ID and App Secret stored securely in environment variables.",
    category: "setup",
    required: true,
  },
  {
    id: "pinterest_redirect_uri",
    title: "Redirect URI Configured",
    description: "OAuth redirect URI matches exactly with app settings (case-sensitive).",
    category: "setup",
    required: true,
  },
  // Scopes & Permissions
  {
    id: "pinterest_boards_read",
    title: "boards:read Scope",
    description: "Permission to read user's boards for pin placement.",
    category: "scopes",
    required: true,
  },
  {
    id: "pinterest_pins_write",
    title: "pins:write Scope",
    description: "Permission to create pins on user's boards.",
    category: "scopes",
    required: true,
  },
  {
    id: "pinterest_user_read",
    title: "user_accounts:read Scope",
    description: "Permission to read basic user account information.",
    category: "scopes",
    required: true,
  },
  // Content Requirements
  {
    id: "pinterest_image_specs",
    title: "Image Specifications Compliance",
    description: "Images meet Pinterest requirements: 2:3 aspect ratio recommended, min 600x900px.",
    category: "content",
    link: "https://developers.pinterest.com/docs/api/v5/#tag/Pins",
    required: true,
  },
  {
    id: "pinterest_board_selection",
    title: "Board Selection UI",
    description: "Users can select which board to pin to from their available boards.",
    category: "content",
    required: true,
  },
  {
    id: "pinterest_link_url",
    title: "Pin Link URL Support",
    description: "Support for adding destination URLs to pins.",
    category: "content",
    required: true,
  },
  {
    id: "pinterest_alt_text",
    title: "Alt Text Support",
    description: "Allow users to add alt text for accessibility.",
    category: "content",
    required: false,
  },
  // Compliance
  {
    id: "pinterest_privacy_policy",
    title: "Privacy Policy in App Settings",
    description: "Privacy policy URL added to Pinterest developer app settings.",
    category: "compliance",
    internalLink: "/privacy",
    required: true,
  },
  {
    id: "pinterest_tos_compliance",
    title: "Pinterest ToS Compliance",
    description: "Application complies with Pinterest Developer Terms of Service.",
    category: "compliance",
    link: "https://developers.pinterest.com/terms/",
    required: true,
  },
  {
    id: "pinterest_brand_guidelines",
    title: "Brand Guidelines Compliance",
    description: "UI follows Pinterest brand guidelines for buttons and icons.",
    category: "compliance",
    link: "https://business.pinterest.com/brand-guidelines/",
    required: false,
  },
  {
    id: "pinterest_rate_limits",
    title: "Rate Limit Handling",
    description: "Proper handling of API rate limits with exponential backoff.",
    category: "compliance",
    required: true,
  },
];

export const pinterestCategoryInfo: Record<string, CategoryInfo> = {
  setup: { label: "App Setup", icon: Settings, color: "text-red-500" },
  scopes: { label: "Scopes & Permissions", icon: Key, color: "text-foreground" },
  content: { label: "Content Requirements", icon: Image, color: "text-foreground" },
  compliance: { label: "Compliance", icon: Shield, color: "text-green-500" },
};
