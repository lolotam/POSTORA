import { AiProvidersPanel } from "@/features/ai-providers";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { CookiePreferencesSection } from "@/components/CookiePreferencesSection";
import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";
import {
  ProfileSection,
  SecuritySection,
  AppearanceSection,
  TimezoneSection,
  MediaRetentionSection,
  NotificationsSection,
  SubscriptionSection,
} from "@/components/settings";

import {
  User,
  Bell,
  Shield,
  Palette,
  Cookie,
  CreditCard,
  Plug,
} from "lucide-react";

/** Mirrors the TabsTrigger values below; an unknown ?tab= falls back to the first. */
const SETTINGS_TABS = [
  "profile",
  "connectors",
  "appearance",
  "subscription",
  "notifications",
  "security",
  "privacy",
  "integrations",
] as const satisfies readonly string[];

export default function Settings() {
  const { t } = useTranslation("accounts");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Resolves tab, aliasing 'connectors' to 'integrations' for backward compatibility
  const rawTab = searchParams.get("tab");

  useEffect(() => {
    // If user accesses legacy tab=api, smoothly redirect to the dedicated /api-keys page
    if (rawTab === "api") {
      navigate("/api-keys", { replace: true });
    }
  }, [rawTab, navigate]);

  const activeTab = rawTab && SETTINGS_TABS.includes(rawTab as (typeof SETTINGS_TABS)[number])
    ? (rawTab === "connectors" ? "integrations" : rawTab)
    : "profile";

  const [isSaving, setIsSaving] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [preferredTimezone, setPreferredTimezone] = useState("");

  const { toast } = useToast();
  const { profile, refreshProfile } = useAuth();

  // The composio-connect callback returns here with ?connection=&result=.
  // The outcome is announced once and the params are dropped, so a refresh or
  // a copied link never re-announces a stale one.
  const connectionId = searchParams.get("connection");
  const connectionResult = searchParams.get("result");

  useEffect(() => {
    if (connectionId === null && connectionResult === null) return;
    if (connectionResult === "ok") {
      toast({
        title: t("settings.toast.appConnected", "App connected"),
        description: t("settings.toast.appConnectedDesc", "The connection is active and can now back an AI agent tool."),
      });
    } else {
      toast({
        title: t("settings.toast.connectionFailed", "Connection not completed"),
        description: t(
          "settings.toast.connectionFailedDesc",
          `The authorization did not complete (${connectionResult ?? "unknown error"}). Try connecting again.`,
          { result: connectionResult ?? t("errors.unknownError", "unknown error") },
        ),
        variant: "destructive",
      });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("connection");
        next.delete("result");
        return next;
      },
      { replace: true },
    );
  }, [connectionId, connectionResult, setSearchParams, toast, t]);

  useEffect(() => {
    if (profile) {
      setFullName(profile.full_name || "");
      setEmail(profile.email || "");
      setPreferredTimezone(profile.preferred_timezone || "");
    }
  }, [profile]);

  const handleSave = async () => {
    if (!profile) return;

    setIsSaving(true);

    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName })
      .eq("id", profile.id);

    if (error) {
      toast({
        title: t("common:error", "Error"),
        description: t("settings.toast.saveFailed", "Failed to save settings."),
        variant: "destructive",
      });
    } else {
      await refreshProfile();
      toast({
        title: t("settings.toast.saved", "Settings saved"),
        description: t("settings.toast.savedDesc", "Your preferences have been updated successfully."),
      });
    }

    setIsSaving(false);
  };

  const handleTabChange = (nextTab: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", nextTab);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">{t("settings.header.title", "Settings")}</h1>
          <p className="text-muted-foreground mt-1">
            {t("settings.header.subtitle", "Manage your account, profile, integrations, connectors, and preferences.")}
          </p>
        </div>

        {/* Tabs Navigation */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="w-full flex flex-wrap justify-start gap-1 h-auto p-1 bg-muted/50 rounded-lg">
            <TabsTrigger value="profile" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <User className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.profile", "Profile")}</span>
            </TabsTrigger>
            <TabsTrigger value="integrations" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <Plug className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.integrations", "Integrations & Connectors")}</span>
            </TabsTrigger>
            <TabsTrigger value="appearance" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <Palette className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.appearance", "Appearance")}</span>
            </TabsTrigger>
            <TabsTrigger value="subscription" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <CreditCard className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.subscription", "Subscription")}</span>
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <Bell className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.notifications", "Notifications")}</span>
            </TabsTrigger>
            <TabsTrigger value="security" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <Shield className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.security", "Security")}</span>
            </TabsTrigger>
            <TabsTrigger value="privacy" className="flex items-center gap-2 data-[state=active]:bg-blue-100 dark:data-[state=active]:bg-blue-900/30 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300">
              <Cookie className="w-4 h-4" />
              <span className="hidden sm:inline">{t("settings.tabs.privacy", "Privacy")}</span>
            </TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile" className="mt-6 space-y-6">
            <ProfileSection
              fullName={fullName}
              setFullName={setFullName}
              email={email}
              onSave={handleSave}
              isSaving={isSaving}
            />
            <TimezoneSection
              preferredTimezone={preferredTimezone}
              setPreferredTimezone={setPreferredTimezone}
            />
            <MediaRetentionSection />
          </TabsContent>

          {/* Unified Integrations & Connectors Tab */}
          <TabsContent value="integrations" className="mt-6 space-y-8">
            <AiProvidersPanel />
            <DatabaseConnectorsManager readOnly />
          </TabsContent>

          {/* Appearance Tab */}
          <TabsContent value="appearance" className="mt-6 space-y-6">
            <AppearanceSection />
          </TabsContent>

          {/* Subscription Tab */}
          <TabsContent value="subscription" className="mt-6 space-y-6">
            <SubscriptionSection />
          </TabsContent>

          {/* Notifications Tab */}
          <TabsContent value="notifications" className="mt-6 space-y-6">
            <NotificationsSection />
          </TabsContent>

          {/* Security Tab */}
          <TabsContent value="security" className="mt-6 space-y-6">
            <SecuritySection />
          </TabsContent>

          {/* Privacy Tab */}
          <TabsContent value="privacy" className="mt-6 space-y-6">
            <CookiePreferencesSection />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
