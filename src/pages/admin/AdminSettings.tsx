import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Loader2, Save, Video, RotateCcw, Globe, Image, Bookmark, CreditCard, Palette, Brain, Cpu, Mail, AlertTriangle, UserCheck, BellRing, type LucideIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_STUDIO_URL } from "@/lib/supabaseStudio";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { AIConfigurationTab } from "@/pages/admin/AIConfigurationTab";
import { AiUsageAnalytics } from "@/components/admin/AiUsageAnalytics";
import { UserAiModelOverrides } from "@/components/admin/UserAiModelOverrides";
import { ThemeSelector } from "@/components/admin/ThemeSelector";
import { BrandIntelligenceSettings } from "@/components/admin/BrandIntelligenceSettings";
import { ScrapingServicesSettings } from "@/components/admin/ScrapingServicesSettings";
import { AppCredentialsSettings } from "@/components/admin/AppCredentialsSettings";
import { TikTokAnalyticsSourceCard } from "@/components/admin/settings/TikTokAnalyticsSourceCard";
import { AdminAiAgentSection } from "@/components/admin/AdminAiAgentSection";
import { useFeatureFlags, FLAG_KEY_MAP, DEFAULT_FLAGS } from "@/hooks/useFeatureFlags";

interface AppSetting {
  id: string;
  key: string;
  value: any;
  description: string | null;
}

const PLATFORM_TOGGLES = [
  {
    key: "tiktok_sandbox_mode",
    label: "TikTok Sandbox Mode",
    description: "Use TikTok Sandbox credentials instead of Production",
    icon: Video,
    badgeText: "🧪 Sandbox",
  },
];

const EMAIL_TOGGLES: Array<{ key: string; label: string; description: string; icon: LucideIcon }> = [
  { key: "user_email_subscription_changes", label: "Subscription Change Emails", description: "Notify users about subscription changes", icon: CreditCard },
  { key: "user_email_post_failure", label: "Post Failure Emails", description: "Notify users when a post fails", icon: AlertTriangle },
  { key: "admin_email_token_health_alerts", label: "Token Health Alerts", description: "Admin alerts for unhealthy tokens", icon: UserCheck },
  { key: "admin_email_ai_override_expiry", label: "AI Override Expiry", description: "Admin alerts for expiring AI overrides", icon: BellRing },
];

const SETTING_META: Record<string, { label: string; icon: LucideIcon; placeholder?: string; isUrl?: boolean }> = {
  app_name: { label: "Application Name", icon: Globe, placeholder: "My App" },
  app_logo: { label: "Logo URL", icon: Image, placeholder: "https://example.com/logo.png", isUrl: true },
  app_favicon: { label: "Favicon URL", icon: Bookmark, placeholder: "https://example.com/favicon.png", isUrl: true },
  default_plan: { label: "Default Plan", icon: CreditCard, placeholder: "free" },
};

export default function AdminSettings() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { broadcastRefresh } = useFeatureFlags();
  const [editedSettings, setEditedSettings] = useState<Record<string, string>>({});
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
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
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      queryClient.invalidateQueries({ queryKey: ["app-settings-public"] });
      toast({ title: "Setting saved" });
    },
    onError: (error) => {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to save", variant: "destructive" });
    },
  });

  const getSettingValue = (setting: AppSetting) => {
    if (editedSettings[setting.key] !== undefined) return editedSettings[setting.key];
    try {
      const parsed = typeof setting.value === "string" ? JSON.parse(setting.value) : setting.value;
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      return String(setting.value);
    }
  };

  const getToggleValue = (key: string): boolean => {
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

  const handleSave = async (key: string) => {
    const value = editedSettings[key];
    if (value === undefined) return;

    // For logo/favicon URLs, upload to Cloudinary first for CDN caching
    if ((key === "app_logo" || key === "app_favicon") && value && value.startsWith("http")) {
      try {
        setUploadingKey(key);
        const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
          body: {
            externalUrl: value,
            fileName: key,
            fileType: "image",
          },
        });
        if (error || !data?.success) {
          toast({ title: "Upload failed", description: data?.error || "Could not upload to CDN", variant: "destructive" });
          setUploadingKey(null);
          return;
        }
        // Store the CDN URL instead of the original
        updateSettingMutation.mutate({ key, value: data.url });
        setEditedSettings((prev) => { const next = { ...prev }; delete next[key]; return next; });
        setUploadingKey(null);
        return;
      } catch (err) {
        toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to upload", variant: "destructive" });
        setUploadingKey(null);
        return;
      }
    }

    updateSettingMutation.mutate({ key, value });
    setEditedSettings((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleToggle = async (key: string, enabled: boolean) => {
    const oldValue = getToggleValue(key);
    updateSettingMutation.mutate({ key, value: enabled });
    if (user?.id) {
      await supabase.from("feature_flag_audit_log").insert({
        feature_key: key,
        old_value: oldValue,
        new_value: enabled,
        changed_by: user.id,
        change_type: "manual",
      });
    }
    await broadcastRefresh();
  };

  const handleResetToDefault = (key: string) => {
    updateSettingMutation.mutate({ key, value: "" });
    setEditedSettings((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const getUrlSettingValue = (key: string): string | null => {
    const setting = settings.find((s) => s.key === key);
    if (!setting) return null;
    const editedValue = editedSettings[key];
    if (editedValue !== undefined) return editedValue || null;
    try {
      const parsed = typeof setting.value === "string" ? JSON.parse(setting.value) : setting.value;
      return parsed || null;
    } catch {
      return null;
    }
  };

  const regularSettings = settings.filter(
    (s) => !s.key.startsWith("feature_") && Object.keys(SETTING_META).includes(s.key)
  );

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Settings</h2>
          <p className="text-muted-foreground">Configure application settings</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* General Settings - Compact Grid */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">General</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {regularSettings.map((setting) => {
                  const meta = SETTING_META[setting.key];
                  if (!meta) return null;
                  const Icon = meta.icon;
                  const hasChanges = editedSettings[setting.key] !== undefined;

                  return (
                    <Card key={setting.id} className="overflow-hidden">
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                            <Icon className="w-3.5 h-3.5 text-primary" />
                          </div>
                          <span className="text-sm font-medium truncate">{meta.label}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            value={getSettingValue(setting)}
                            onChange={(e) =>
                              setEditedSettings((prev) => ({ ...prev, [setting.key]: e.target.value }))
                            }
                            className="h-8 text-xs flex-1"
                            placeholder={meta.placeholder}
                          />
                          <Button
                            size="sm"
                            className="h-8 px-2"
                            onClick={() => handleSave(setting.key)}
                            disabled={!hasChanges || updateSettingMutation.isPending}
                          >
                            {(updateSettingMutation.isPending && !uploadingKey) || uploadingKey === setting.key ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5" />
                            )}
                          </Button>
                          {meta.isUrl && getUrlSettingValue(setting.key) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2"
                              onClick={() => handleResetToDefault(setting.key)}
                              disabled={updateSettingMutation.isPending}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                        {/* Logo/Favicon preview */}
                        {setting.key === "app_logo" && (
                          <div className="flex justify-center items-center gap-2 p-2 rounded border bg-muted/30">
                            <button
                              type="button"
                              className="cursor-pointer hover:opacity-80 transition-opacity"
                              onClick={() => {
                                const url = getUrlSettingValue("app_logo");
                                if (url) setPreviewImage(url);
                              }}
                            >
                              {getUrlSettingValue("app_logo") ? (
                                <img src={getUrlSettingValue("app_logo")!} alt="Logo" className="w-[50px] h-[50px] object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              ) : (
                                <div className="w-[50px] h-[50px] rounded bg-primary/20 flex items-center justify-center">
                                  <Image className="w-5 h-5 text-primary" />
                                </div>
                              )}
                            </button>
                            <span className="text-[10px] text-muted-foreground">{getUrlSettingValue("app_logo") ? "Custom" : "Default"}</span>
                          </div>
                        )}
                        {setting.key === "app_favicon" && (
                          <div className="flex justify-center items-center gap-2 p-2 rounded border bg-muted/30">
                            <button
                              type="button"
                              className="cursor-pointer hover:opacity-80 transition-opacity"
                              onClick={() => {
                                const url = getUrlSettingValue("app_favicon") || "/favicon.png";
                                setPreviewImage(url);
                              }}
                            >
                              {getUrlSettingValue("app_favicon") ? (
                                <img src={getUrlSettingValue("app_favicon")!} alt="Favicon" className="w-[50px] h-[50px] object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              ) : (
                                <img src="/favicon.png" alt="Default" className="w-[50px] h-[50px] object-contain" />
                              )}
                            </button>
                            <span className="text-[10px] text-muted-foreground">{getUrlSettingValue("app_favicon") ? "Custom" : "Default"}</span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Toggles Section - Platform & Email */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Toggles</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {/* TikTok Sandbox */}
                {PLATFORM_TOGGLES.map((toggle) => {
                  const Icon = toggle.icon;
                  const isEnabled = getToggleValue(toggle.key);
                  return (
                    <Card key={toggle.key} className={`overflow-hidden ${isEnabled ? 'ring-2 ring-primary/50 bg-primary/5' : ''}`}>
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                              <Icon className="w-3.5 h-3.5 text-primary" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-medium truncate">{toggle.label}</p>
                                {isEnabled && (
                                  <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-secondary text-secondary-foreground shrink-0">
                                    {toggle.badgeText}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground line-clamp-1">{toggle.description}</p>
                            </div>
                          </div>
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={(checked) => handleToggle(toggle.key, checked)}
                            disabled={updateSettingMutation.isPending}
                            className="scale-90 shrink-0"
                          />
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}

                {/* Email Toggles */}
                {EMAIL_TOGGLES.map((toggle) => {
                  const Icon = toggle.icon;
                  const isEnabled = getToggleValue(toggle.key);
                  return (
                    <Card key={toggle.key} className={`overflow-hidden ${isEnabled ? 'ring-2 ring-primary/50 bg-primary/5' : ''}`}>
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                              <Icon className="w-3.5 h-3.5 text-primary" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{toggle.label}</p>
                              <p className="text-[11px] text-muted-foreground line-clamp-1">{toggle.description}</p>
                            </div>
                          </div>
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={(checked) => handleToggle(toggle.key, checked)}
                            disabled={updateSettingMutation.isPending}
                            className="scale-90 shrink-0"
                          />
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* App Credentials (includes WhatsApp Embedded Signup) */}
            <AppCredentialsSettings />

            {/* Dark Theme Selector */}
            <ThemeSelector />

            {/* Brand Intelligence Settings */}
            <BrandIntelligenceSettings />

            {/* External Scraping Services */}
            <ScrapingServicesSettings />

            {/* TikTok Analytics Data Source */}
            <TikTokAnalyticsSourceCard />

            {/* AI Configuration */}
            <AIConfigurationTab />

            {/* AI Usage Analytics */}
            <AiUsageAnalytics />

            {/* User AI Model Overrides */}
            <UserAiModelOverrides />

            {/* Email Templates */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                    <Mail className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span className="text-sm font-medium">Email Templates</span>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Email templates are managed in the Supabase Dashboard under Authentication → Email Templates.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={SUPABASE_STUDIO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Supabase Dashboard
                  </a>
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Image Preview Dialog */}
      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-md flex items-center justify-center p-6">
          {previewImage && (
            <img src={previewImage} alt="Preview" className="max-w-full max-h-[400px] object-contain rounded" />
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
