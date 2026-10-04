import { Settings, Key, FileText, Shield } from "lucide-react";
import { ChecklistItem, CategoryInfo } from "../types";

export const redditChecklistItems: ChecklistItem[] = [
  // App Setup
  {
    id: "reddit_dev_app",
    title: "Reddit Developer App Created",
    description: "Application registered in Reddit App Preferences with correct app type (web app).",
    category: "setup",
    link: "https://www.reddit.com/prefs/apps",
    required: true,
  },
  {
    id: "reddit_client_credentials",
    title: "Client ID and Secret Configured",
    description: "Reddit Client ID and Client Secret stored securely in environment variables.",
    category: "setup",
    required: true,
  },
  {
    id: "reddit_redirect_uri",
    title: "Redirect URI Configured",
    description: "OAuth redirect URI matches exactly with app settings.",
    category: "setup",
    required: true,
  },
  {
    id: "reddit_user_agent",
    title: "Custom User Agent Set",
    description: "Unique, descriptive User-Agent header for all API requests (required by Reddit).",
    category: "setup",
    link: "https://github.com/reddit-archive/reddit/wiki/API",
    required: true,
  },
  // Scopes & Permissions
  {
    id: "reddit_identity_scope",
    title: "identity Scope",
    description: "Access to user's Reddit identity (username, karma, etc.).",
    category: "scopes",
    required: true,
  },
  {
    id: "reddit_submit_scope",
    title: "submit Scope",
    description: "Permission to submit links and comments on behalf of the user.",
    category: "scopes",
    required: true,
  },
  {
    id: "reddit_read_scope",
    title: "read Scope",
    description: "Access to read subreddit content and user subscriptions.",
    category: "scopes",
    required: true,
  },
  {
    id: "reddit_mysubreddits_scope",
    title: "mysubreddits Scope",
    description: "Access to user's subscribed subreddits for posting.",
    category: "scopes",
    required: false,
  },
  // Content Requirements
  {
    id: "reddit_text_limits",
    title: "Post Character Limits",
    description: "Text posts: 40,000 characters. Titles: 300 characters.",
    category: "content",
    required: true,
  },
  {
    id: "reddit_subreddit_selection",
    title: "Subreddit Selection UI",
    description: "Allow users to select target subreddit with validation.",
    category: "content",
    required: true,
  },
  {
    id: "reddit_flair_support",
    title: "Flair Support",
    description: "Support for subreddit flairs when required.",
    category: "content",
    required: false,
  },
  {
    id: "reddit_nsfw_marking",
    title: "NSFW Content Marking",
    description: "Support for marking posts as NSFW when appropriate.",
    category: "content",
    required: false,
  },
  // Compliance
  {
    id: "reddit_api_terms",
    title: "Reddit API Terms Compliance",
    description: "Application complies with Reddit API Terms of Use.",
    category: "compliance",
    link: "https://www.reddit.com/wiki/api-terms",
    required: true,
  },
  {
    id: "reddit_rate_limits",
    title: "Rate Limit Handling",
    description: "Handle rate limits: 60 requests/minute for OAuth clients.",
    category: "compliance",
    link: "https://github.com/reddit-archive/reddit/wiki/API#rules",
    required: true,
  },
  {
    id: "reddit_content_policy",
    title: "Reddit Content Policy",
    description: "Ensure posted content complies with Reddit Content Policy.",
    category: "compliance",
    link: "https://www.redditinc.com/policies/content-policy",
    required: true,
  },
  {
    id: "reddit_privacy_policy",
    title: "Privacy Policy URL",
    description: "Privacy policy URL in app description.",
    category: "compliance",
    internalLink: "/privacy",
    required: true,
  },
];

export const redditCategoryInfo: Record<string, CategoryInfo> = {
  setup: { label: "App Setup", icon: Settings, color: "text-orange-500" },
  scopes: { label: "Scopes & Permissions", icon: Key, color: "text-foreground" },
  content: { label: "Content Requirements", icon: FileText, color: "text-red-500" },
  compliance: { label: "Compliance", icon: Shield, color: "text-green-500" },
};
