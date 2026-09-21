import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, RefreshCw, Plus, Video, Shrink, Crop, Sparkles, Hash, Image, PenTool, FileCheck, ImageIcon, FileText, ListOrdered, ZoomIn, Mail, Crown, Unlock, Bug, Wrench, Instagram, RotateCcw, Pencil, Share2, Link, MessageSquare, MapPin, Film, Settings2, Users, Facebook, MessageCircle, Music, Youtube, Linkedin, Twitter, Globe, BookOpen, Clock, ExternalLink, Megaphone, ShoppingBag, Headphones, BarChart3, AtSign } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { UserFeatureOverrides } from "@/components/admin/UserFeatureOverrides";
import { FeatureFlagAuditLog } from "@/components/admin/FeatureFlagAuditLog";
import { FeatureFlagScheduler } from "@/components/admin/FeatureFlagScheduler";
import { FeatureFlagCard } from "@/components/admin/FeatureFlagCard";
import { useFeatureFlags, DEFAULT_FLAGS, FLAG_KEY_MAP } from "@/hooks/useFeatureFlags";
import { useBetaPlatforms, BetaPlatforms } from "@/hooks/useBetaPlatforms";
import { TabsContent } from "@/components/ui/tabs";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { allPlatforms } from "@/lib/platformConstants";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";

interface AppSetting {
  id: string;
  key: string;
  value: any;
  description: string | null;
}

const FEATURE_FLAGS = [
  { key: "feature_video_compress", label: "Video Compression", description: "Allow users to compress videos before uploading", icon: Shrink },
  { key: "feature_tiktok_transcode", label: "TikTok Transcode", description: "Allow users to transcode videos for TikTok format", icon: Video },
  { key: "feature_tiktok_precheck", label: "TikTok Video Pre-Check", description: "Enable TikTok video pre-check validation before upload", icon: FileCheck },
  { key: "feature_image_crop", label: "Image Cropping", description: "Allow users to crop images before uploading", icon: Crop },
  { key: "feature_ai_caption", label: "AI Caption Generation", description: "Allow users to generate post captions using AI", icon: Sparkles },
  { key: "feature_ai_hashtags", label: "AI Hashtag Suggestions", description: "Allow users to generate hashtags using AI", icon: Hash },
  { key: "feature_ai_thumbnails", label: "AI Thumbnails", description: "Allow users to generate video thumbnails using AI", icon: Image },
  { key: "feature_ai_image", label: "AI Image Generation", description: "Allow users to generate images using AI", icon: Sparkles },
  { key: "feature_stock_upload", label: "Stock Upload", description: "Show Stock media upload button for users", icon: ImageIcon },
  { key: "feature_canvas", label: "Canvas", description: "Show Canvas feature in the header navigation", icon: PenTool },
  { key: "feature_title_required", label: "Title Required", description: "Require a title for all media posts with configurable character limit", icon: FileText, hasCharacterLimit: true },
  { key: "feature_media_counter", label: "Media Counter", description: "Show media counter indicator in post creation", icon: ListOrdered },
  { key: "feature_atlascloud_upscale", label: "AtlasCloud 4K Upscaling", description: "Enable premium 4K image upscaling via AtlasCloud API", icon: ZoomIn },
  { key: "feature_email_notifications", label: "Email Notifications", description: "Token expiry warnings, connection alerts & announcements", icon: Mail },
  { key: "feature_weekly_summary", label: "Weekly Summary", description: "Receive a weekly report of your activity", icon: FileText },
  { key: "feature_platform_access", label: "Platform Access", description: "Show Platform Access overview card on the Profiles page", icon: Crown },
  { key: "feature_free_platforms", label: "Free Platforms", description: "Show Free Platforms grid inside the Platform Access card", icon: Unlock },
  { key: "feature_tiktok_oauth_debug", label: "TikTok OAuth Debug", description: "Show TikTok OAuth Debug panel on the Profiles page", icon: Bug },
  { key: "feature_connection_troubleshooter", label: "Connection Troubleshooter", description: "Show Connection Troubleshooter on the Profiles page", icon: Wrench },
  { key: "feature_instagram_via_facebook", label: "Instagram via Facebook", description: "Facebook page connection can also discover/connect linked Instagram accounts", icon: Instagram },
  { key: "feature_reuse_post_data", label: "Reuse Post Data", description: "Allow users to reuse caption, media, or full post data from History", icon: RotateCcw },
  // Facebook Posting
  { key: "feature_fb_post_type", label: "FB Post Type", description: "Show Post Type selector (Feed/Story/Reel) in Facebook settings", icon: Film },
  { key: "feature_fb_location", label: "FB Location", description: "Show Location field in Facebook settings", icon: MapPin },
  { key: "feature_fb_first_comment", label: "FB First Comment", description: "Show First Comment field in Facebook settings", icon: MessageSquare },
  { key: "feature_fb_link", label: "FB Link", description: "Show Link field in Facebook settings", icon: Link },
  { key: "feature_fb_share_to_story", label: "FB Share to Story", description: "Show 'Also share to Story' toggle in Facebook settings", icon: Share2 },
  // Instagram Posting
  { key: "feature_ig_post_type", label: "IG Post Type", description: "Show Post Type selector (Feed/Story/Reel) in Instagram settings", icon: Film },
  { key: "feature_ig_location", label: "IG Location", description: "Show Location field in Instagram settings", icon: MapPin },
  { key: "feature_ig_first_comment", label: "IG First Comment", description: "Show First Comment field in Instagram settings", icon: MessageSquare },
  { key: "feature_ig_collaborator", label: "IG Collaborator", description: "Show Invite Collaborator field in Instagram settings", icon: Users },
  { key: "feature_ig_advanced_settings", label: "IG Advanced Settings", description: "Show Advanced Settings (Hide Likes, Disable Comments) in Instagram settings", icon: Settings2 },
  // Connected Accounts
  { key: "feature_tab_facebook", label: "Facebook Tab", description: "Show Facebook tab in Connected Accounts on Profiles page", icon: Facebook },
  { key: "feature_tab_instagram", label: "Instagram Tab", description: "Show Instagram tab in Connected Accounts on Profiles page", icon: Instagram },
  { key: "feature_tab_threads", label: "Threads Tab", description: "Show Threads tab in Connected Accounts on Profiles page", icon: MessageCircle },
  { key: "feature_tab_tiktok", label: "TikTok Tab", description: "Show TikTok tab in Connected Accounts on Profiles page", icon: Music },
  { key: "feature_tab_youtube", label: "YouTube Tab", description: "Show YouTube tab in Connected Accounts on Profiles page", icon: Youtube },
  { key: "feature_tab_linkedin", label: "LinkedIn Tab", description: "Show LinkedIn tab in Connected Accounts on Profiles page", icon: Linkedin },
  { key: "feature_tab_twitter", label: "X Tab", description: "Show X (Twitter) tab in Connected Accounts on Profiles page", icon: Twitter },
  { key: "feature_tab_pinterest", label: "Pinterest Tab", description: "Show Pinterest tab in Connected Accounts on Profiles page", icon: Globe },
  { key: "feature_tab_bluesky", label: "Bluesky Tab", description: "Show Bluesky tab in Connected Accounts on Profiles page", icon: Globe },
  { key: "feature_tab_reddit", label: "Reddit Tab", description: "Show Reddit tab in Connected Accounts on Profiles page", icon: BookOpen },
  { key: "feature_token_expires", label: "Token Expires", description: "Show Token Expires column in Connected Accounts table for regular users", icon: Clock },
  { key: "feature_token_lifetime", label: "Token Lifetime", description: "Show Token Lifetime column in Connected Accounts table for regular users", icon: Clock },
  { key: "feature_threads_share_to_ig", label: "Threads Share to Instagram", description: "Show the Share to Instagram Story option in Threads post settings", icon: Share2 },
  // Messaging Platform Visibility
  { key: "feature_msg_facebook", label: "Messaging Facebook", description: "Show Facebook Messenger tab in the Messaging section for users", icon: Facebook },
  { key: "feature_msg_instagram", label: "Messaging Instagram", description: "Show Instagram DMs tab in the Messaging section for users", icon: Instagram },
  { key: "feature_msg_whatsapp", label: "Messaging WhatsApp", description: "Show WhatsApp Business tab in the Messaging section for users", icon: MessageSquare },
  { key: "feature_msg_threads", label: "Messaging Threads Mentions", description: "Show Threads Mentions tab in the Messaging section for users", icon: AtSign },
  { key: "feature_comment_manager", label: "Messaging Comments Inbox", description: "Show Comments inbox tab in the Messaging section for users", icon: MessageSquare },
  { key: "feature_wa_cloud_api_enabled", label: "WhatsApp Cloud API Mode", description: "Show the 'Cloud API Only' connection option alongside Coexistence. Disable to force all users to Coexistence (recommended).", icon: MessageSquare },
  { key: "feature_wa_evolution_qr_enabled", label: "WhatsApp Direct QR Mode", description: "Show the Direct QR connection option for self-hosted WhatsApp sessions.", icon: MessageSquare },
  { key: "feature_marketero_button", label: "Marketero Button", description: "Show the Marketero button in the Dashboard header", icon: ExternalLink },
  // Analytics dropdown sub-pages
  { key: "feature_analytics_facebook", label: "Analytics: Facebook", description: "Show Facebook entry in the Analytics dropdown in the sidebar", icon: Facebook },
  { key: "feature_analytics_instagram", label: "Analytics: Instagram", description: "Show Instagram entry in the Analytics dropdown in the sidebar", icon: Instagram },
  { key: "feature_analytics_threads", label: "Analytics: Threads", description: "Show Threads entry in the Analytics dropdown in the sidebar", icon: MessageCircle },
  { key: "feature_analytics_tiktok", label: "Analytics: TikTok", description: "Show TikTok entry in the Analytics dropdown in the sidebar", icon: Music },
  // Ad Manager dropdown
  { key: "feature_ad_manager", label: "Ad Manager", description: "Show Ad Manager entry in the Ad Manager dropdown in the sidebar", icon: Megaphone },
  { key: "feature_ad_analytics", label: "Ad Analytics", description: "Show Ad Analytics entry in the Ad Manager dropdown in the sidebar", icon: BarChart3 },
  { key: "feature_leads_crm", label: "Leads CRM", description: "Show Leads CRM entry in the Ad Manager dropdown in the sidebar", icon: Users },
  { key: "feature_human_agent", label: "Human Agent", description: "Show Human Agent entry in the Ad Manager dropdown in the sidebar", icon: Headphones },
  { key: "feature_whatsapp_shop", label: "WhatsApp Shop", description: "Show WhatsApp Shop entry in the Ad Manager dropdown in the sidebar", icon: ShoppingBag },
];

const DEFAULT_CATEGORIES: Record<string, string> = {
  feature_video_compress: "Media",
  feature_tiktok_transcode: "Media",
  feature_tiktok_precheck: "Media",
  feature_image_crop: "Media",
  feature_stock_upload: "Media",
  feature_media_counter: "Media",
  feature_ai_caption: "AI",
  feature_ai_hashtags: "AI",
  feature_ai_thumbnails: "AI",
  feature_ai_image: "AI",
  feature_atlascloud_upscale: "AI",
  feature_instagram_via_facebook: "Social",
  feature_reuse_post_data: "Social",
  feature_platform_access: "Social",
  feature_free_platforms: "Social",
  feature_threads_share_to_ig: "Social",
  feature_canvas: "UI",
  feature_title_required: "UI",
  feature_email_notifications: "Notifications",
  feature_weekly_summary: "Notifications",
  feature_tiktok_oauth_debug: "Debug",
  feature_connection_troubleshooter: "Debug",
  // Facebook Posting
  feature_fb_post_type: "Facebook Posting",
  feature_fb_location: "Facebook Posting",
  feature_fb_first_comment: "Facebook Posting",
  feature_fb_link: "Facebook Posting",
  feature_fb_share_to_story: "Facebook Posting",
  // Instagram Posting
  feature_ig_post_type: "Instagram Posting",
  feature_ig_location: "Instagram Posting",
  feature_ig_first_comment: "Instagram Posting",
  feature_ig_collaborator: "Instagram Posting",
  feature_ig_advanced_settings: "Instagram Posting",
  // Connected Accounts
  feature_tab_facebook: "Connected Accounts",
  feature_tab_instagram: "Connected Accounts",
  feature_tab_threads: "Connected Accounts",
  feature_tab_tiktok: "Connected Accounts",
  feature_tab_youtube: "Connected Accounts",
  feature_tab_linkedin: "Connected Accounts",
  feature_tab_twitter: "Connected Accounts",
  feature_tab_pinterest: "Connected Accounts",
  feature_tab_bluesky: "Connected Accounts",
  feature_tab_reddit: "Connected Accounts",
  feature_token_expires: "Connected Accounts",
  feature_token_lifetime: "Connected Accounts",
  feature_marketero_button: "UI",
  // Messaging
  feature_msg_facebook: "Messaging",
  feature_msg_instagram: "Messaging",
  feature_msg_whatsapp: "Messaging",
  feature_msg_threads: "Messaging",
  feature_comment_manager: "Messaging",
  // Analytics dropdown
  feature_analytics_facebook: "Analytics",
  feature_analytics_instagram: "Analytics",
  feature_analytics_threads: "Analytics",
  feature_analytics_tiktok: "Analytics",
  // Ad Manager dropdown
  feature_ad_manager: "Ad Manager",
  feature_ad_analytics: "Ad Manager",
  feature_leads_crm: "Ad Manager",
  feature_human_agent: "Ad Manager",
  feature_whatsapp_shop: "Ad Manager",
};

export default function AdminFeatureFlags() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { broadcastRefresh } = useFeatureFlags();
  const { betaPlatforms } = useBetaPlatforms();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [titleCharacterLimit, setTitleCharacterLimit] = useState<number>(100);
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [topTab, setTopTab] = useState("feature-flags");

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async (): Promise<AppSetting[]> => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("*")
        .order("key");
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch category assignments
  const categoryMap = useMemo((): Record<string, string> => {
    const setting = settings.find((s) => s.key === "feature_flag_categories");
    if (!setting) return DEFAULT_CATEGORIES;
    try {
      const parsed = typeof setting.value === "string" ? JSON.parse(setting.value) : setting.value;
      return { ...DEFAULT_CATEGORIES, ...parsed };
    } catch {
      return DEFAULT_CATEGORIES;
    }
  }, [settings]);

  const allCategories = useMemo(() => {
    const cats = new Set(Object.entries(categoryMap).map(([key, val]) => {
      // Placeholder keys like __category_<name> store the category name as the value
      return key.startsWith("__category_") ? val : val;
    }));
    return Array.from(cats).sort();
  }, [categoryMap]);

  const filteredFlags = useMemo(() => {
    if (selectedCategory === "All") return FEATURE_FLAGS;
    return FEATURE_FLAGS.filter((f) => (categoryMap[f.key] || "Uncategorized") === selectedCategory);
  }, [selectedCategory, categoryMap]);

  const updateSettingMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      if (error) throw error;
    },
    onSuccess: () => {
      // admin-settings refresh is fine immediately (admin RLS sees everything).
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
      // feature-flags invalidation is intentionally NOT done here — the
      // toggle handler defers it so the optimistic broadcast update is not
      // overridden by an immediate stale refetch.
      toast({ title: "Setting saved" });
    },
    onError: (error) => {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to save", variant: "destructive" });
    },
  });

  const getFeatureFlagValue = (key: string): boolean => {
    const setting = settings.find((s) => s.key === key);
    if (!setting) {
      const flagKey = FLAG_KEY_MAP[key];
      if (flagKey) return DEFAULT_FLAGS[flagKey];
      return false;
    }
    try {
      const parsed = typeof setting.value === "string" ? JSON.parse(setting.value) : setting.value;
      return parsed === true || parsed === "true";
    } catch {
      return setting.value === "true";
    }
  };

  const handleFeatureToggle = async (key: string, enabled: boolean) => {
    const oldValue = getFeatureFlagValue(key);

    try {
      await updateSettingMutation.mutateAsync({ key, value: enabled });

      if (user?.id) {
        await supabase.from("feature_flag_audit_log").insert({
          feature_key: key,
          old_value: oldValue,
          new_value: enabled,
          changed_by: user.id,
          change_type: "manual",
        });
        queryClient.invalidateQueries({ queryKey: ["feature-flag-audit-log"] });
      }

      if (import.meta.env.DEV) {
        console.debug("[feature-flags] toggle", key, enabled);
      }

      // Broadcast first so all open tabs (including this admin tab) apply
      // the optimistic update from the realtime payload.
      await broadcastRefresh({ featureKey: key, enabled });

      // Reconcile with DB after a short delay so Postgres replication has
      // settled. This prevents a stale refetch from clobbering the optimistic
      // value that the broadcast just set.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      }, 200);
    } catch {
      // Toast is already handled by the mutation's onError callback.
    }
  };

  const handleCategoryChange = async (flagKey: string, newCategory: string) => {
    const updated = { ...categoryMap, [flagKey]: newCategory };
    updateSettingMutation.mutate({ key: "feature_flag_categories", value: updated });
  };

  const handleRenameCategory = (oldName: string) => {
    const newName = prompt(`Rename category "${oldName}" to:`, oldName);
    if (!newName || newName.trim() === "" || newName.trim() === oldName) return;
    const trimmed = newName.trim();
    if (allCategories.includes(trimmed)) {
      toast({ title: "Category already exists", variant: "destructive" });
      return;
    }
    const updated = { ...categoryMap };
    for (const key of Object.keys(updated)) {
      if (updated[key] === oldName) {
        updated[key] = trimmed;
      }
    }
    updateSettingMutation.mutate({ key: "feature_flag_categories", value: updated });
    if (selectedCategory === oldName) {
      setSelectedCategory(trimmed);
    }
    toast({ title: `Category renamed to "${trimmed}"` });
  };

  const handleAddCategory = () => {
    const name = prompt("Enter new category name:");
    if (!name || name.trim() === "") return;
    const trimmed = name.trim();
    if (allCategories.includes(trimmed)) {
      toast({ title: "Category already exists", variant: "destructive" });
      return;
    }
    // Persist with a placeholder key so empty categories survive page refreshes
    const updated = { ...categoryMap, [`__category_${trimmed}`]: trimmed };
    updateSettingMutation.mutate({ key: "feature_flag_categories", value: updated });
    toast({ title: `Category "${trimmed}" created`, description: "Assign flags to it using the dropdown on each card." });
  };

  const handleRefreshAllFlags = async () => {
    setIsRefreshing(true);
    try {
      await broadcastRefresh();
      toast({ title: "Flags refreshed", description: "All connected users will receive updated feature flags instantly." });
    } catch {
      toast({ title: "Error", description: "Failed to broadcast flag refresh", variant: "destructive" });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleBetaToggle = (platform: Platform, enabled: boolean) => {
    const updated: BetaPlatforms = { ...betaPlatforms, [platform]: enabled };
    updateSettingMutation.mutate({ key: "beta_platforms", value: updated });
    queryClient.invalidateQueries({ queryKey: ["beta-platforms"] });
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Feature Flags</h2>
            <p className="text-muted-foreground">Toggle features on/off for all users</p>
          </div>
          <div className="flex items-center gap-2">
            {topTab === "feature-flags" && (
              <>
                <Button variant="outline" size="sm" onClick={handleAddCategory}>
                  <Plus className="w-4 h-4 me-2" />
                  New Category
                </Button>
                <Button variant="outline" size="sm" onClick={handleRefreshAllFlags} disabled={isRefreshing}>
                  {isRefreshing ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <RefreshCw className="w-4 h-4 me-2" />}
                  Refresh All Users
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Top-level Tabs */}
        <Tabs value={topTab} onValueChange={setTopTab}>
          <TabsList>
            <TabsTrigger value="feature-flags">Feature Flags</TabsTrigger>
            <TabsTrigger value="beta-functions">Beta Functions</TabsTrigger>
          </TabsList>

          <TabsContent value="feature-flags">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-6">
                {/* Category Tabs */}
                <Tabs value={selectedCategory} onValueChange={setSelectedCategory}>
                  <TabsList className="flex-wrap h-auto gap-1">
                    <TabsTrigger value="All">All ({FEATURE_FLAGS.length})</TabsTrigger>
                    {allCategories.map((cat) => {
                      const count = FEATURE_FLAGS.filter((f) => categoryMap[f.key] === cat).length;
                      return (
                        <TabsTrigger key={cat} value={cat} className="group gap-1.5">
                          {cat} ({count})
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRenameCategory(cat); }}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
                            title={`Rename "${cat}"`}
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                </Tabs>

                {/* Feature Flags Grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {filteredFlags.map((flag) => (
                    <FeatureFlagCard
                      key={flag.key}
                      flagKey={flag.key}
                      label={flag.label}
                      description={flag.description}
                      icon={flag.icon}
                      isEnabled={getFeatureFlagValue(flag.key)}
                      hasCharacterLimit={'hasCharacterLimit' in flag && flag.hasCharacterLimit}
                      titleCharacterLimit={titleCharacterLimit}
                      onTitleCharacterLimitChange={setTitleCharacterLimit}
                      onSaveCharacterLimit={() => updateSettingMutation.mutate({ key: "title_character_limit", value: titleCharacterLimit })}
                      onToggle={handleFeatureToggle}
                      isPending={updateSettingMutation.isPending}
                      category={categoryMap[flag.key] || "Uncategorized"}
                      categories={allCategories}
                      onCategoryChange={handleCategoryChange}
                    />
                  ))}
                </div>

                {/* Scheduled Changes and Activity Log */}
                <div className="grid gap-6 lg:grid-cols-2">
                  <FeatureFlagScheduler />
                  <FeatureFlagAuditLog />
                </div>

                {/* User Feature Overrides */}
                <UserFeatureOverrides />
              </div>
            )}
          </TabsContent>

          <TabsContent value="beta-functions">
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold">Platform Beta Badges</h3>
                <p className="text-sm text-muted-foreground">
                  Toggle beta status for platforms. A "Beta" badge will appear next to the platform name in Connected Accounts.
                </p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {allPlatforms.map((config) => {
                  const isEnabled = !!betaPlatforms[config.platform];
                  return (
                    <Card
                      key={config.platform}
                      className={`p-4 flex flex-col items-center gap-3 transition-colors ${isEnabled ? "border-amber-500/50 bg-amber-500/5" : ""}`}
                    >
                      <PlatformIcon platform={config.platform} size="md" />
                      <span className="text-sm font-medium">{config.name}</span>
                      {isEnabled && (
                        <span className="text-[10px] font-semibold text-amber-600 bg-amber-500/20 px-2 py-0.5 rounded-full">Beta</span>
                      )}
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={(checked) => handleBetaToggle(config.platform, checked)}
                        disabled={updateSettingMutation.isPending}
                      />
                    </Card>
                  );
                })}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
