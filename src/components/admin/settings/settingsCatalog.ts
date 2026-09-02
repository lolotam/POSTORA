import type { SearchableSection } from "@/lib/settingsSearch";

/**
 * What the settings page renders, and the index it is searched by.
 *
 * Deliberately metadata only — no component imports. Pulling the section components in
 * here would make every consumer (including a test of the search rules) load the whole
 * admin tree. The components are bound to these ids in AdminSettings via a
 * `Record<SettingsSectionId, ...>`, so a section added here without a component, or a
 * component whose id is not here, is a type error rather than a silently missing panel.
 *
 * Keywords are maintained by hand: keep them to the field names and synonyms someone
 * would actually type, not to every string rendered inside a section.
 */
export const SETTINGS_SECTIONS = [
  {
    id: "identity",
    tab: "general",
    title: "Identity",
    keywords: ["app name", "application name", "site name", "logo", "favicon", "icon", "default plan", "branding"],
  },
  {
    id: "theme",
    tab: "general",
    title: "Theme",
    keywords: ["theme", "dark mode", "light mode", "colour", "color", "palette", "appearance", "style"],
  },
  {
    id: "app-credentials",
    tab: "integrations",
    title: "App credentials",
    keywords: [
      "oauth", "credentials", "app id", "app secret", "client key", "client secret", "api key",
      "facebook", "instagram", "tiktok", "youtube", "pinterest", "threads", "whatsapp",
      "embedded signup", "meta",
    ],
  },
  {
    id: "tiktok-sandbox",
    tab: "integrations",
    title: "TikTok sandbox mode",
    keywords: ["tiktok", "sandbox", "production", "test mode", "credentials", "staging"],
  },
  {
    id: "tiktok-analytics-source",
    tab: "integrations",
    title: "TikTok analytics source",
    keywords: ["tiktok", "analytics", "data source", "insights", "metrics"],
  },
  {
    id: "cdn-storage",
    tab: "integrations",
    title: "CDN and storage",
    keywords: ["cdn", "storage", "cloudinary", "openinary", "media", "uploads", "images", "bucket"],
  },
  {
    id: "scraping-services",
    tab: "integrations",
    title: "Scraping services",
    keywords: ["scraping", "scraper", "apify", "actor", "endpoint", "external services", "enrichment", "crawler", "brand data"],
  },
  // One section per model category, in the order they appear as sub-tabs. Splitting the
  // former single "AI models and providers" section is what lets each card own a sub-tab,
  // and it also gives the search bar something to match: "embedding" and "transcription"
  // hit nothing while all seven categories shared one keyword list.
  {
    id: "ai-search-models",
    tab: "ai",
    title: "Search Models",
    subTab: "Search Models",
    keywords: ["search", "web search", "grounding", "perplexity", "browse", "model", "fallback"],
  },
  {
    id: "ai-embedding-models",
    tab: "ai",
    title: "Embedding",
    subTab: "Embedding",
    keywords: ["embedding", "vector", "rag", "knowledge base", "dimensions", "similarity", "re-embed"],
  },
  {
    id: "ai-agent-models",
    tab: "ai",
    title: "AI Agent",
    subTab: "AI Agent",
    keywords: ["agent", "messaging", "whatsapp", "chat", "reply", "model", "conversation", "inbox"],
  },
  {
    id: "ai-stt-models",
    tab: "ai",
    title: "Speech to Text",
    subTab: "Speech to Text",
    keywords: ["speech to text", "stt", "transcription", "transcribe", "voice note", "whisper", "audio"],
  },
  {
    id: "ai-tts-models",
    tab: "ai",
    title: "Text to Speech",
    subTab: "Text to Speech",
    keywords: ["text to speech", "tts", "voice", "narration", "audio", "speak"],
  },
  {
    id: "ai-video-models",
    tab: "ai",
    title: "Video Generation",
    subTab: "Video Generation",
    keywords: ["video", "video generation", "clip", "veo", "higgsfield", "motion"],
  },
  {
    id: "ai-chat-models",
    tab: "ai",
    title: "Chat Models",
    subTab: "Chat Models",
    keywords: ["chat", "text", "caption", "hashtags", "completion", "gpt", "gemini", "claude", "prompt"],
  },
  {
    id: "ai-image-models",
    tab: "ai",
    title: "Image Generation",
    subTab: "Image Generation",
    keywords: ["image", "image generation", "picture", "art", "dall-e", "flux", "render"],
  },
  {
    id: "ai-providers",
    tab: "ai",
    title: "Providers and API keys",
    subTab: "Providers",
    keywords: [
      "provider", "api key", "openai", "gemini", "google", "openrouter", "anthropic",
      "connection", "test", "firecrawl", "apify", "scraping", "credentials",
    ],
  },
  {
    id: "brand-intelligence",
    tab: "ai",
    title: "Brand intelligence",
    keywords: ["brand", "intelligence", "analysis", "voice", "tone", "audience"],
  },
  {
    id: "higgsfield",
    tab: "ai",
    title: "Higgsfield",
    keywords: ["higgsfield", "video", "video generation", "image generation", "media generation"],
  },
  {
    id: "user-ai-overrides",
    tab: "ai",
    title: "Per-user model overrides",
    keywords: ["override", "per user", "user model", "model override", "expiry", "quota", "exception"],
  },
] as const satisfies readonly SearchableSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
