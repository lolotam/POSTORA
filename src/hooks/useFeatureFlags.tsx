import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useEffect, useCallback, useRef } from "react";
import { toast } from "@/hooks/use-toast";
import { useNotificationHistoryStore } from "@/stores/notificationHistoryStore";
import { normalizeFeatureKey } from "@/stores/notificationHistoryStore";
import { useUserRole } from "@/hooks/useUserRole";

export interface FeatureFlags {
  videoCompress: boolean;
  tiktokTranscode: boolean;
  tiktokPreCheck: boolean;
  imageCrop: boolean;
  aiCaption: boolean;
  aiHashtags: boolean;
  aiThumbnails: boolean;
  aiImage: boolean;
  stockUpload: boolean;
  canvas: boolean;
  titleRequired: boolean;
  mediaCounter: boolean;
  atlascloudUpscale: boolean;
  emailNotifications: boolean;
  platformAccess: boolean;
  freePlatforms: boolean;
  tiktokOAuthDebug: boolean;
  connectionTroubleshooter: boolean;
  instagramViaFacebook: boolean;
  reusePostData: boolean;
  // Facebook Posting flags
  fbPostType: boolean;
  fbLocation: boolean;
  fbFirstComment: boolean;
  fbLink: boolean;
  fbShareToStory: boolean;
  // Instagram Posting flags
  igPostType: boolean;
  igLocation: boolean;
  igFirstComment: boolean;
  igCollaborator: boolean;
  igAdvancedSettings: boolean;
  // Connected Accounts tab visibility flags
  tabFacebook: boolean;
  tabInstagram: boolean;
  tabThreads: boolean;
  tabTiktok: boolean;
  tabYoutube: boolean;
  tabLinkedin: boolean;
  tabTwitter: boolean;
  tabPinterest: boolean;
  tabBluesky: boolean;
  tabReddit: boolean;
  tabWhatsapp: boolean;
  // Token column visibility flags
  tokenExpires: boolean;
  tokenLifetime: boolean;
  brandIntelligence: boolean;
  threadsShareToIg: boolean;
  // Messaging platform visibility flags
  msgFacebook: boolean;
  msgInstagram: boolean;
  msgWhatsapp: boolean;
  msgThreads: boolean;
  msgThreadsReply: boolean;
  msgThreadsAutomation: boolean;
  msgThreadsWebhooks: boolean;
  msgThreadsAssignment: boolean;
  // Monetization features
  commentManager: boolean;
  commentWorkflow: boolean;
  youtubeComments: boolean;
  leadsCrm: boolean;
  audienceHub: boolean;
  adAnalytics: boolean;
  smartScheduling: boolean;
  humanAgent: boolean;
  whatsappShop: boolean;
  adManager: boolean;
  marketeroButton: boolean;
  waCloudApiEnabled: boolean;
  waEvolutionQrEnabled: boolean;
  // Analytics dropdown sub-pages
  analyticsFacebook: boolean;
  analyticsInstagram: boolean;
  analyticsThreads: boolean;
  analyticsTiktok: boolean;
}

// Title required settings stored separately
export interface TitleRequiredSettings {
  enabled: boolean;
  characterLimit: number;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  videoCompress: true,
  tiktokTranscode: true,
  tiktokPreCheck: false,
  imageCrop: true,
  aiCaption: true,
  aiHashtags: true,
  aiThumbnails: true,
  aiImage: true,
  stockUpload: false,
  canvas: false,
  titleRequired: false,
  mediaCounter: false,
  atlascloudUpscale: false,
  emailNotifications: false,
  platformAccess: true,
  freePlatforms: true,
  tiktokOAuthDebug: false,
  connectionTroubleshooter: false,
  instagramViaFacebook: false,
  reusePostData: true,
  fbPostType: true,
  fbLocation: true,
  fbFirstComment: true,
  fbLink: true,
  fbShareToStory: true,
  igPostType: true,
  igLocation: true,
  igFirstComment: true,
  igCollaborator: true,
  igAdvancedSettings: true,
  tabFacebook: true,
  tabInstagram: true,
  tabThreads: true,
  tabTiktok: true,
  tabYoutube: true,
  tabLinkedin: true,
  tabTwitter: true,
  tabPinterest: true,
  tabBluesky: true,
  tabReddit: true,
  tabWhatsapp: true,
  tokenExpires: true,
  tokenLifetime: true,
  brandIntelligence: false,
  threadsShareToIg: false,
  msgFacebook: false,
  msgInstagram: false,
  msgWhatsapp: false,
  msgThreads: false,
  msgThreadsReply: false,
  msgThreadsAutomation: false,
  msgThreadsWebhooks: false,
  msgThreadsAssignment: false,
  commentManager: false,
  commentWorkflow: false,
  youtubeComments: false,
  leadsCrm: false,
  audienceHub: false,
  adAnalytics: false,
  smartScheduling: false,
  humanAgent: false,
  whatsappShop: false,
  adManager: false,
  marketeroButton: true,
  waCloudApiEnabled: false,
  waEvolutionQrEnabled: false,
  analyticsFacebook: false,
  analyticsInstagram: false,
  analyticsThreads: false,
  analyticsTiktok: false,
};

export const DEFAULT_TITLE_SETTINGS: TitleRequiredSettings = {
  enabled: false,
  characterLimit: 100,
};

export const FLAG_KEYS = [
  "feature_video_compress",
  "feature_tiktok_transcode",
  "feature_tiktok_precheck",
  "feature_image_crop",
  "feature_ai_caption",
  "feature_ai_hashtags",
  "feature_ai_thumbnails",
  "feature_ai_image",
  "feature_stock_upload",
  "feature_canvas",
  "feature_title_required",
  "feature_media_counter",
  "feature_atlascloud_upscale",
  "feature_email_notifications",
  "feature_platform_access",
  "feature_free_platforms",
  "feature_tiktok_oauth_debug",
  "feature_connection_troubleshooter",
  "feature_instagram_via_facebook",
  "feature_reuse_post_data",
  "feature_fb_post_type",
  "feature_fb_location",
  "feature_fb_first_comment",
  "feature_fb_link",
  "feature_fb_share_to_story",
  "feature_ig_post_type",
  "feature_ig_location",
  "feature_ig_first_comment",
  "feature_ig_collaborator",
  "feature_ig_advanced_settings",
  "feature_tab_facebook",
  "feature_tab_instagram",
  "feature_tab_threads",
  "feature_tab_tiktok",
  "feature_tab_youtube",
  "feature_tab_linkedin",
  "feature_tab_twitter",
  "feature_tab_pinterest",
  "feature_tab_bluesky",
  "feature_tab_reddit",
  "feature_tab_whatsapp",
  "feature_token_expires",
  "feature_token_lifetime",
  "feature_brand_intelligence",
  "feature_threads_share_to_ig",
  "feature_msg_facebook",
  "feature_msg_instagram",
  "feature_msg_whatsapp",
  "feature_msg_threads",
  "feature_msg_threads_reply",
  "feature_msg_threads_automation",
  "feature_msg_threads_webhooks",
  "feature_msg_threads_assignment",
  "feature_comment_manager",
  "feature_comment_workflow",
  "feature_youtube_comments",
  "feature_leads_crm",
  "feature_audience_hub",
  "feature_ad_analytics",
  "feature_smart_scheduling",
  "feature_human_agent",
  "feature_whatsapp_shop",
  "feature_ad_manager",
  "feature_marketero_button",
  "feature_wa_cloud_api_enabled",
  "feature_wa_evolution_qr_enabled",
  "feature_analytics_facebook",
  "feature_analytics_instagram",
  "feature_analytics_threads",
  "feature_analytics_tiktok",
];

export const FLAG_KEY_MAP: Record<string, keyof FeatureFlags> = {
  feature_video_compress: "videoCompress",
  feature_tiktok_transcode: "tiktokTranscode",
  feature_tiktok_precheck: "tiktokPreCheck",
  feature_image_crop: "imageCrop",
  feature_ai_caption: "aiCaption",
  feature_ai_hashtags: "aiHashtags",
  feature_ai_thumbnails: "aiThumbnails",
  feature_ai_image: "aiImage",
  feature_stock_upload: "stockUpload",
  feature_canvas: "canvas",
  feature_title_required: "titleRequired",
  feature_media_counter: "mediaCounter",
  feature_atlascloud_upscale: "atlascloudUpscale",
  feature_email_notifications: "emailNotifications",
  feature_platform_access: "platformAccess",
  feature_free_platforms: "freePlatforms",
  feature_tiktok_oauth_debug: "tiktokOAuthDebug",
  feature_connection_troubleshooter: "connectionTroubleshooter",
  feature_instagram_via_facebook: "instagramViaFacebook",
  feature_reuse_post_data: "reusePostData",
  feature_fb_post_type: "fbPostType",
  feature_fb_location: "fbLocation",
  feature_fb_first_comment: "fbFirstComment",
  feature_fb_link: "fbLink",
  feature_fb_share_to_story: "fbShareToStory",
  feature_ig_post_type: "igPostType",
  feature_ig_location: "igLocation",
  feature_ig_first_comment: "igFirstComment",
  feature_ig_collaborator: "igCollaborator",
  feature_ig_advanced_settings: "igAdvancedSettings",
  feature_tab_facebook: "tabFacebook",
  feature_tab_instagram: "tabInstagram",
  feature_tab_threads: "tabThreads",
  feature_tab_tiktok: "tabTiktok",
  feature_tab_youtube: "tabYoutube",
  feature_tab_linkedin: "tabLinkedin",
  feature_tab_twitter: "tabTwitter",
  feature_tab_pinterest: "tabPinterest",
  feature_tab_bluesky: "tabBluesky",
  feature_tab_reddit: "tabReddit",
  feature_tab_whatsapp: "tabWhatsapp",
  feature_token_expires: "tokenExpires",
  feature_token_lifetime: "tokenLifetime",
  feature_brand_intelligence: "brandIntelligence",
  feature_threads_share_to_ig: "threadsShareToIg",
  feature_msg_facebook: "msgFacebook",
  feature_msg_instagram: "msgInstagram",
  feature_msg_whatsapp: "msgWhatsapp",
  feature_msg_threads: "msgThreads",
  feature_msg_threads_reply: "msgThreadsReply",
  feature_msg_threads_automation: "msgThreadsAutomation",
  feature_msg_threads_webhooks: "msgThreadsWebhooks",
  feature_msg_threads_assignment: "msgThreadsAssignment",
  feature_comment_manager: "commentManager",
  feature_comment_workflow: "commentWorkflow",
  feature_youtube_comments: "youtubeComments",
  feature_leads_crm: "leadsCrm",
  feature_audience_hub: "audienceHub",
  feature_ad_analytics: "adAnalytics",
  feature_smart_scheduling: "smartScheduling",
  feature_human_agent: "humanAgent",
  feature_whatsapp_shop: "whatsappShop",
  feature_ad_manager: "adManager",
  feature_marketero_button: "marketeroButton",
  feature_wa_cloud_api_enabled: "waCloudApiEnabled",
  feature_wa_evolution_qr_enabled: "waEvolutionQrEnabled",
  feature_analytics_facebook: "analyticsFacebook",
  feature_analytics_instagram: "analyticsInstagram",
  feature_analytics_threads: "analyticsThreads",
  feature_analytics_tiktok: "analyticsTiktok",
};

// Channel name for realtime broadcast
const FEATURE_FLAGS_CHANNEL = "feature-flags-refresh";

// Reverse map: camelCase flag key -> DB feature_key (e.g. adManager -> feature_ad_manager)
const REVERSE_FLAG_KEY_MAP: Partial<Record<keyof FeatureFlags, string>> = Object.entries(
  FLAG_KEY_MAP
).reduce((acc, [dbKey, camelKey]) => {
  acc[camelKey as keyof FeatureFlags] = dbKey;
  return acc;
}, {} as Partial<Record<keyof FeatureFlags, string>>);

// Human-readable labels for features
const FEATURE_DISPLAY_NAMES: Record<keyof FeatureFlags, string> = {
  videoCompress: "Video Compression",
  tiktokTranscode: "TikTok Transcode",
  tiktokPreCheck: "TikTok Pre-Check",
  imageCrop: "Image Cropping",
  aiCaption: "AI Caption",
  aiHashtags: "AI Hashtags",
  aiThumbnails: "AI Thumbnails",
  aiImage: "AI Image Generation",
  stockUpload: "Stock Upload",
  canvas: "Canvas",
  titleRequired: "Title Required",
  mediaCounter: "Media Counter",
  atlascloudUpscale: "AtlasCloud 4K Upscale",
  emailNotifications: "Email Notifications",
  platformAccess: "Platform Access",
  freePlatforms: "Free Platforms",
  tiktokOAuthDebug: "TikTok OAuth Debug",
  connectionTroubleshooter: "Connection Troubleshooter",
  instagramViaFacebook: "Instagram via Facebook",
  reusePostData: "Reuse Post Data",
  fbPostType: "FB Post Type",
  fbLocation: "FB Location",
  fbFirstComment: "FB First Comment",
  fbLink: "FB Link",
  fbShareToStory: "FB Share to Story",
  igPostType: "IG Post Type",
  igLocation: "IG Location",
  igFirstComment: "IG First Comment",
  igCollaborator: "IG Collaborator",
  igAdvancedSettings: "IG Advanced Settings",
  tabFacebook: "Facebook Tab",
  tabInstagram: "Instagram Tab",
  tabThreads: "Threads Tab",
  tabTiktok: "TikTok Tab",
  tabYoutube: "YouTube Tab",
  tabLinkedin: "LinkedIn Tab",
  tabTwitter: "X Tab",
  tabPinterest: "Pinterest Tab",
  tabBluesky: "Bluesky Tab",
  tabReddit: "Reddit Tab",
  tabWhatsapp: "WhatsApp Tab",
  tokenExpires: "Token Expires",
  tokenLifetime: "Token Lifetime",
  brandIntelligence: "Brand Intelligence",
  threadsShareToIg: "Threads Share to Instagram",
  msgFacebook: "Messaging Facebook",
  msgInstagram: "Messaging Instagram",
  msgWhatsapp: "Messaging WhatsApp",
  msgThreads: "Messaging Threads Mentions",
  msgThreadsReply: "Threads Reply",
  msgThreadsAutomation: "Threads Automation",
  msgThreadsWebhooks: "Threads Webhooks",
  msgThreadsAssignment: "Threads Assignment",
  commentManager: "Messaging Comments Inbox",
  commentWorkflow: "Comment Workflow",
  youtubeComments: "YouTube Comments",
  leadsCrm: "Leads CRM",
  audienceHub: "Audience & Contacts",
  adAnalytics: "Ad Analytics",
  smartScheduling: "Smart Scheduling",
  humanAgent: "Human Agent",
  whatsappShop: "WhatsApp Shop",
  adManager: "Ad Manager",
  marketeroButton: "Marketero Button",
  waCloudApiEnabled: "WhatsApp Cloud API Mode",
  waEvolutionQrEnabled: "WhatsApp Direct QR Mode",
  analyticsFacebook: "Analytics: Facebook",
  analyticsInstagram: "Analytics: Instagram",
  analyticsThreads: "Analytics: Threads",
  analyticsTiktok: "Analytics: TikTok",
};

// All flags enabled for admins - they always have full access
const ALL_FLAGS_ENABLED: FeatureFlags = {
  videoCompress: true,
  tiktokTranscode: true,
  tiktokPreCheck: true,
  imageCrop: true,
  aiCaption: true,
  aiHashtags: true,
  aiThumbnails: true,
  aiImage: true,
  stockUpload: true,
  canvas: true,
  titleRequired: true,
  mediaCounter: true,
  atlascloudUpscale: true,
  emailNotifications: true,
  platformAccess: true,
  freePlatforms: true,
  tiktokOAuthDebug: true,
  connectionTroubleshooter: true,
  instagramViaFacebook: true,
  reusePostData: true,
  fbPostType: true,
  fbLocation: true,
  fbFirstComment: true,
  fbLink: true,
  fbShareToStory: true,
  igPostType: true,
  igLocation: true,
  igFirstComment: true,
  igCollaborator: true,
  igAdvancedSettings: true,
  tabFacebook: true,
  tabInstagram: true,
  tabThreads: true,
  tabTiktok: true,
  tabYoutube: true,
  tabLinkedin: true,
  tabTwitter: true,
  tabPinterest: true,
  tabBluesky: true,
  tabReddit: true,
  tabWhatsapp: true,
  tokenExpires: true,
  tokenLifetime: true,
  brandIntelligence: true,
  threadsShareToIg: true,
  msgFacebook: true,
  msgInstagram: true,
  msgWhatsapp: true,
  msgThreads: true,
  msgThreadsReply: true,
  msgThreadsAutomation: true,
  msgThreadsWebhooks: true,
  msgThreadsAssignment: true,
  commentManager: true,
  commentWorkflow: true,
  youtubeComments: true,
  leadsCrm: true,
  audienceHub: true,
  adAnalytics: true,
  smartScheduling: true,
  humanAgent: true,
  whatsappShop: true,
  adManager: true,
  marketeroButton: true,
  waCloudApiEnabled: true,
  waEvolutionQrEnabled: true,
  analyticsFacebook: true,
  analyticsInstagram: true,
  analyticsThreads: true,
  analyticsTiktok: true,
};

export function useFeatureFlags() {
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const queryClient = useQueryClient();
  const previousFlagsRef = useRef<FeatureFlags | null>(null);
  const notifiedFlagsRef = useRef<Set<string>>(new Set());
  const addNotification = useNotificationHistoryStore((state) => state.addNotification);

  const { data: fetchedFlags = DEFAULT_FLAGS, isLoading } = useQuery({
    queryKey: ["feature-flags", user?.id],
    queryFn: async (): Promise<FeatureFlags> => {
      // Read previous cache so a partial DB response (e.g. RLS hides a key)
      // never collapses an already-known flag back to its default.
      const prevCache = queryClient.getQueryData<FeatureFlags>(["feature-flags", user?.id]);

      // Fetch global settings
      const { data: globalSettings, error: globalError } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", FLAG_KEYS);

      if (globalError) {
        console.error("Error fetching feature flags:", globalError);
        // Preserve previous cache rather than collapsing to defaults on error.
        return prevCache ?? DEFAULT_FLAGS;
      }

      // Build global flags
      const globalFlagMap: Record<string, boolean> = {};
      for (const row of globalSettings || []) {
        try {
          // Value could be: true, false, "true", "false", or JSON string like "\"true\""
          let val = row.value;
          // If it's a string, try to parse it as JSON first
          if (typeof val === "string") {
            try {
              val = JSON.parse(val);
            } catch {
              // If parsing fails, keep it as the original string
            }
          }
          // Now check if it's truthy
          globalFlagMap[row.key] = val === true || val === "true";
        } catch {
          globalFlagMap[row.key] = row.value === true || row.value === "true";
        }
      }

      const baseFromDb: FeatureFlags = {
        videoCompress: globalFlagMap["feature_video_compress"] ?? DEFAULT_FLAGS.videoCompress,
        tiktokTranscode: globalFlagMap["feature_tiktok_transcode"] ?? DEFAULT_FLAGS.tiktokTranscode,
        tiktokPreCheck: globalFlagMap["feature_tiktok_precheck"] ?? DEFAULT_FLAGS.tiktokPreCheck,
        imageCrop: globalFlagMap["feature_image_crop"] ?? DEFAULT_FLAGS.imageCrop,
        aiCaption: globalFlagMap["feature_ai_caption"] ?? DEFAULT_FLAGS.aiCaption,
        aiHashtags: globalFlagMap["feature_ai_hashtags"] ?? DEFAULT_FLAGS.aiHashtags,
        aiThumbnails: globalFlagMap["feature_ai_thumbnails"] ?? DEFAULT_FLAGS.aiThumbnails,
        aiImage: globalFlagMap["feature_ai_image"] ?? DEFAULT_FLAGS.aiImage,
        stockUpload: globalFlagMap["feature_stock_upload"] ?? DEFAULT_FLAGS.stockUpload,
        canvas: globalFlagMap["feature_canvas"] ?? DEFAULT_FLAGS.canvas,
        titleRequired: globalFlagMap["feature_title_required"] ?? DEFAULT_FLAGS.titleRequired,
        mediaCounter: globalFlagMap["feature_media_counter"] ?? DEFAULT_FLAGS.mediaCounter,
        atlascloudUpscale: globalFlagMap["feature_atlascloud_upscale"] ?? DEFAULT_FLAGS.atlascloudUpscale,
        emailNotifications: globalFlagMap["feature_email_notifications"] ?? DEFAULT_FLAGS.emailNotifications,
        platformAccess: globalFlagMap["feature_platform_access"] ?? DEFAULT_FLAGS.platformAccess,
        freePlatforms: globalFlagMap["feature_free_platforms"] ?? DEFAULT_FLAGS.freePlatforms,
        tiktokOAuthDebug: globalFlagMap["feature_tiktok_oauth_debug"] ?? DEFAULT_FLAGS.tiktokOAuthDebug,
        connectionTroubleshooter: globalFlagMap["feature_connection_troubleshooter"] ?? DEFAULT_FLAGS.connectionTroubleshooter,
        instagramViaFacebook: globalFlagMap["feature_instagram_via_facebook"] ?? DEFAULT_FLAGS.instagramViaFacebook,
        reusePostData: globalFlagMap["feature_reuse_post_data"] ?? DEFAULT_FLAGS.reusePostData,
        fbPostType: globalFlagMap["feature_fb_post_type"] ?? DEFAULT_FLAGS.fbPostType,
        fbLocation: globalFlagMap["feature_fb_location"] ?? DEFAULT_FLAGS.fbLocation,
        fbFirstComment: globalFlagMap["feature_fb_first_comment"] ?? DEFAULT_FLAGS.fbFirstComment,
        fbLink: globalFlagMap["feature_fb_link"] ?? DEFAULT_FLAGS.fbLink,
        fbShareToStory: globalFlagMap["feature_fb_share_to_story"] ?? DEFAULT_FLAGS.fbShareToStory,
        igPostType: globalFlagMap["feature_ig_post_type"] ?? DEFAULT_FLAGS.igPostType,
        igLocation: globalFlagMap["feature_ig_location"] ?? DEFAULT_FLAGS.igLocation,
        igFirstComment: globalFlagMap["feature_ig_first_comment"] ?? DEFAULT_FLAGS.igFirstComment,
        igCollaborator: globalFlagMap["feature_ig_collaborator"] ?? DEFAULT_FLAGS.igCollaborator,
        igAdvancedSettings: globalFlagMap["feature_ig_advanced_settings"] ?? DEFAULT_FLAGS.igAdvancedSettings,
        tabFacebook: globalFlagMap["feature_tab_facebook"] ?? DEFAULT_FLAGS.tabFacebook,
        tabInstagram: globalFlagMap["feature_tab_instagram"] ?? DEFAULT_FLAGS.tabInstagram,
        tabThreads: globalFlagMap["feature_tab_threads"] ?? DEFAULT_FLAGS.tabThreads,
        tabTiktok: globalFlagMap["feature_tab_tiktok"] ?? DEFAULT_FLAGS.tabTiktok,
        tabYoutube: globalFlagMap["feature_tab_youtube"] ?? DEFAULT_FLAGS.tabYoutube,
        tabLinkedin: globalFlagMap["feature_tab_linkedin"] ?? DEFAULT_FLAGS.tabLinkedin,
        tabTwitter: globalFlagMap["feature_tab_twitter"] ?? DEFAULT_FLAGS.tabTwitter,
        tabPinterest: globalFlagMap["feature_tab_pinterest"] ?? DEFAULT_FLAGS.tabPinterest,
        tabBluesky: globalFlagMap["feature_tab_bluesky"] ?? DEFAULT_FLAGS.tabBluesky,
        tabReddit: globalFlagMap["feature_tab_reddit"] ?? DEFAULT_FLAGS.tabReddit,
        tabWhatsapp: globalFlagMap["feature_tab_whatsapp"] ?? DEFAULT_FLAGS.tabWhatsapp,
        tokenExpires: globalFlagMap["feature_token_expires"] ?? DEFAULT_FLAGS.tokenExpires,
        tokenLifetime: globalFlagMap["feature_token_lifetime"] ?? DEFAULT_FLAGS.tokenLifetime,
        brandIntelligence: globalFlagMap["feature_brand_intelligence"] ?? DEFAULT_FLAGS.brandIntelligence,
        threadsShareToIg: globalFlagMap["feature_threads_share_to_ig"] ?? DEFAULT_FLAGS.threadsShareToIg,
        msgFacebook: globalFlagMap["feature_msg_facebook"] ?? DEFAULT_FLAGS.msgFacebook,
        msgInstagram: globalFlagMap["feature_msg_instagram"] ?? DEFAULT_FLAGS.msgInstagram,
        msgWhatsapp: globalFlagMap["feature_msg_whatsapp"] ?? DEFAULT_FLAGS.msgWhatsapp,
        msgThreads: globalFlagMap["feature_msg_threads"] ?? DEFAULT_FLAGS.msgThreads,
        msgThreadsReply: globalFlagMap["feature_msg_threads_reply"] ?? DEFAULT_FLAGS.msgThreadsReply,
        msgThreadsAutomation: globalFlagMap["feature_msg_threads_automation"] ?? DEFAULT_FLAGS.msgThreadsAutomation,
        msgThreadsWebhooks: globalFlagMap["feature_msg_threads_webhooks"] ?? DEFAULT_FLAGS.msgThreadsWebhooks,
        msgThreadsAssignment: globalFlagMap["feature_msg_threads_assignment"] ?? DEFAULT_FLAGS.msgThreadsAssignment,
        commentManager: globalFlagMap["feature_comment_manager"] ?? DEFAULT_FLAGS.commentManager,
        commentWorkflow: globalFlagMap["feature_comment_workflow"] ?? DEFAULT_FLAGS.commentWorkflow,
        youtubeComments: globalFlagMap["feature_youtube_comments"] ?? DEFAULT_FLAGS.youtubeComments,
        leadsCrm: globalFlagMap["feature_leads_crm"] ?? DEFAULT_FLAGS.leadsCrm,
        audienceHub: globalFlagMap["feature_audience_hub"] ?? DEFAULT_FLAGS.audienceHub,
        adAnalytics: globalFlagMap["feature_ad_analytics"] ?? DEFAULT_FLAGS.adAnalytics,
        smartScheduling: globalFlagMap["feature_smart_scheduling"] ?? DEFAULT_FLAGS.smartScheduling,
        humanAgent: globalFlagMap["feature_human_agent"] ?? DEFAULT_FLAGS.humanAgent,
        whatsappShop: globalFlagMap["feature_whatsapp_shop"] ?? DEFAULT_FLAGS.whatsappShop,
        adManager: globalFlagMap["feature_ad_manager"] ?? DEFAULT_FLAGS.adManager,
        marketeroButton: globalFlagMap["feature_marketero_button"] ?? DEFAULT_FLAGS.marketeroButton,
        waCloudApiEnabled: globalFlagMap["feature_wa_cloud_api_enabled"] ?? DEFAULT_FLAGS.waCloudApiEnabled,
        waEvolutionQrEnabled: globalFlagMap["feature_wa_evolution_qr_enabled"] ?? DEFAULT_FLAGS.waEvolutionQrEnabled,
        analyticsFacebook: globalFlagMap["feature_analytics_facebook"] ?? DEFAULT_FLAGS.analyticsFacebook,
        analyticsInstagram: globalFlagMap["feature_analytics_instagram"] ?? DEFAULT_FLAGS.analyticsInstagram,
        analyticsThreads: globalFlagMap["feature_analytics_threads"] ?? DEFAULT_FLAGS.analyticsThreads,
        analyticsTiktok: globalFlagMap["feature_analytics_tiktok"] ?? DEFAULT_FLAGS.analyticsTiktok,
      };

      // Defensive merge: defaults <- previous cache <- current DB result.
      // This keeps the last-known value for any flag the DB happened to omit
      // (e.g. partial RLS visibility) instead of silently flipping it to false.
      const baseFlags: FeatureFlags = {
        ...DEFAULT_FLAGS,
        ...(prevCache ?? {}),
        ...baseFromDb,
      };

      // If user is logged in, fetch their overrides (only for non-admins, admins get full access anyway)
      if (user?.id) {
        const { data: overrides, error: overridesError } = await supabase
          .from("user_feature_overrides")
          .select("feature_key, enabled, expires_at")
          .eq("user_id", user.id);

        if (!overridesError && overrides) {
          const now = new Date();
          for (const override of overrides) {
            // Skip expired overrides
            if (override.expires_at && new Date(override.expires_at) < now) {
              continue;
            }
            const flagKey = FLAG_KEY_MAP[override.feature_key];
            if (flagKey && flagKey in baseFlags) {
              baseFlags[flagKey] = override.enabled;
            }
          }
        }
      }

      return baseFlags;
    },
    staleTime: 30 * 1000, // Cache for 30 seconds for more responsive admin control
    refetchOnWindowFocus: true, // Refetch when user returns to tab
  });

  // ADMIN OVERRIDE: Admins get all features EXCEPT "visibility" flags
  // Visibility flags control page-section visibility for ALL users including admins
  const VISIBILITY_FLAG_KEYS: Array<keyof FeatureFlags> = [
    // Comment Workflow sits here because its page queries tables a migration creates.
    // Admins otherwise receive every flag regardless of its stored value, so the page
    // would mount during the window between a merge (which auto-deploys the frontend)
    // and the migration being applied by hand, querying relations that do not exist yet.
    "commentWorkflow",
    // YouTube Comments sits here for the same reason: its tile, agent surface and workflow
    // platform write youtube rows that the CHECK constraints admit only once the migration is
    // applied by hand, while the merge auto-deploys this frontend.
    "youtubeComments",
    "platformAccess",
    "freePlatforms",
    "tiktokOAuthDebug",
    "connectionTroubleshooter",
    "reusePostData",
    "fbPostType",
    "fbLocation",
    "fbFirstComment",
    "fbLink",
    "fbShareToStory",
    "igPostType",
    "igLocation",
    "igFirstComment",
    "igCollaborator",
    "igAdvancedSettings",
    "tokenExpires",
    "tokenLifetime",
  ];

  const flags = isAdmin
    ? {
        ...ALL_FLAGS_ENABLED,
        ...Object.fromEntries(
          VISIBILITY_FLAG_KEYS.map((key) => [key, fetchedFlags[key]])
        ),
      } as FeatureFlags
    : fetchedFlags;

  // Show toast + activity notifications when feature flags change — ADMIN ONLY.
  // Regular users silently update their baseline and never get a feature-flag toast/activity entry.
  // Compare against FETCHED flags (not admin-overridden) to avoid false positives on login.
  useEffect(() => {
    // Wait until data is loaded
    if (isLoading) return;

    const sessionKey = `feature_flags_state_${user?.id || 'anon'}`;
    const initializedKey = `feature_flags_initialized_${user?.id || 'anon'}`;

    // Check if this is the first load of this session
    const isInitialized = sessionStorage.getItem(initializedKey) === 'true';

    if (!isInitialized) {
      // First load of session — store baseline silently and never notify
      sessionStorage.setItem(sessionKey, JSON.stringify(fetchedFlags));
      sessionStorage.setItem(initializedKey, 'true');
      previousFlagsRef.current = { ...fetchedFlags };
      return;
    }

    // INVERSE GUARD: regular users never get feature-flag toasts/activity entries.
    // Update baseline silently and bail out.
    if (!isAdmin) {
      sessionStorage.setItem(sessionKey, JSON.stringify(fetchedFlags));
      previousFlagsRef.current = { ...fetchedFlags };
      return;
    }

    // Admin path — emit one notification per actual value change.
    const storedState = sessionStorage.getItem(sessionKey);
    const lastKnownState: FeatureFlags | null = storedState ? JSON.parse(storedState) : null;
    const compareAgainst = lastKnownState || previousFlagsRef.current;

    if (compareAgainst !== null) {
      const changedFeatures: { name: string; flagKey: keyof FeatureFlags; enabled: boolean }[] = [];

      (Object.keys(fetchedFlags) as Array<keyof FeatureFlags>).forEach((key) => {
        if (compareAgainst[key] !== fetchedFlags[key]) {
          changedFeatures.push({
            name: FEATURE_DISPLAY_NAMES[key],
            flagKey: key,
            enabled: fetchedFlags[key],
          });
        }
      });

      if (changedFeatures.length > 0) {
        changedFeatures.forEach(({ name, flagKey, enabled }) => {
          const dbKey = REVERSE_FLAG_KEY_MAP[flagKey] ?? String(flagKey);
          const normalizedKey = normalizeFeatureKey(dbKey);

          // Layer 2 dedupe: 2-second time-bucket guard against double-fire from
          // realtime broadcast → query invalidate re-runs of this effect.
          const bucketKey = `${normalizedKey}:${enabled}:${Math.floor(Date.now() / 2000)}`;
          if (notifiedFlagsRef.current.has(bucketKey)) return;
          notifiedFlagsRef.current.add(bucketKey);
          // Cap the dedupe set so it doesn't grow unboundedly
          if (notifiedFlagsRef.current.size > 200) {
            notifiedFlagsRef.current = new Set(
              Array.from(notifiedFlagsRef.current).slice(-100)
            );
          }

          const title = enabled ? "Feature Enabled" : "Feature Disabled";
          const description = `${name} has been ${enabled ? "enabled" : "disabled"}.`;

          toast({
            title,
            description,
            variant: enabled ? "default" : "destructive",
          });

          // Layer 3 dedupe handled inside the store (normalized metadata + 2s window)
          addNotification({
            type: "feature_flag",
            title,
            description,
            variant: enabled ? "success" : "destructive",
            metadata: { featureKey: normalizedKey, newValue: enabled },
          });
        });

        sessionStorage.setItem(sessionKey, JSON.stringify(fetchedFlags));
      }
    }

    previousFlagsRef.current = { ...fetchedFlags };
  }, [fetchedFlags, isLoading, addNotification, isAdmin, user?.id]);

  // Subscribe to realtime broadcast for instant flag updates
  useEffect(() => {
    const channel = supabase
      .channel(FEATURE_FLAGS_CHANNEL)
      .on("broadcast", { event: "refresh" }, ({ payload }) => {
        if (import.meta.env.DEV) {
          console.debug("[feature-flags] broadcast received", payload);
        }

        const changedFlagKey = payload?.featureKey ? FLAG_KEY_MAP[payload.featureKey] : null;
        const changedEnabled = typeof payload?.enabled === "boolean" ? payload.enabled : null;

        if (changedFlagKey && changedEnabled !== null) {
          // Optimistic: realtime payload is the source of truth for this key.
          queryClient.setQueriesData({ queryKey: ["feature-flags"] }, (current) => {
            const base =
              current && typeof current === "object"
                ? (current as FeatureFlags)
                : DEFAULT_FLAGS;
            return {
              ...DEFAULT_FLAGS,
              ...base,
              [changedFlagKey]: changedEnabled,
            } as FeatureFlags;
          });
        }

        // Reconcile with DB after a short delay so Postgres replication has
        // a moment to settle and the refetch doesn't overwrite the optimistic
        // update with a stale read.
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
        }, 200);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Function to broadcast refresh to all clients
  const broadcastRefresh = useCallback(async (change?: { featureKey?: string; enabled?: boolean }) => {
    const channel = supabase.channel(FEATURE_FLAGS_CHANNEL);
    await channel.subscribe();
    await channel.send({
      type: "broadcast",
      event: "refresh",
      payload: {
        timestamp: Date.now(),
        featureKey: change?.featureKey,
        enabled: change?.enabled,
      },
    });
    // Clean up the channel after sending
    setTimeout(() => {
      supabase.removeChannel(channel);
    }, 1000);
  }, []);

  if (import.meta.env.DEV) {
    // Surface resolved flags during development for easy verification
    // (regular user sessions can confirm all 9 sidebar flags resolve correctly).
    console.debug("[feature-flags] resolved", flags);
  }

  return { flags, isLoading, broadcastRefresh };
}
