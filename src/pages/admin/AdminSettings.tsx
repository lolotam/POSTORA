import { Link, useSearchParams } from "react-router-dom";
import { Bot, Plug, Settings as SettingsIcon } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AIConfigurationTab } from "@/pages/admin/AIConfigurationTab";
import { UserAiModelOverrides } from "@/components/admin/UserAiModelOverrides";
import { ThemeSelector } from "@/components/admin/ThemeSelector";
import { BrandIntelligenceSettings } from "@/components/admin/BrandIntelligenceSettings";
import { ScrapingServicesSettings } from "@/components/admin/ScrapingServicesSettings";
import { AppCredentialsSettings } from "@/components/admin/AppCredentialsSettings";
import { TikTokAnalyticsSourceCard } from "@/components/admin/settings/TikTokAnalyticsSourceCard";
import { CdnStorageSettings } from "@/components/admin/settings/CdnStorageSettings";
import { HiggsfieldIntegrationCard } from "@/components/admin/settings/HiggsfieldIntegrationCard";
import { GeneralIdentitySettings } from "@/components/admin/settings/GeneralIdentitySettings";
import { TikTokSandboxToggle } from "@/components/admin/settings/TikTokSandboxToggle";
import { AdminAiAgentSection } from "@/components/admin/AdminAiAgentSection";

const TABS = ["general", "integrations", "ai"] as const;
type SettingsTab = (typeof TABS)[number];

const DEFAULT_TAB: SettingsTab = "general";

function readTab(value: string | null): SettingsTab {
  return TABS.includes(value as SettingsTab) ? (value as SettingsTab) : DEFAULT_TAB;
}

export default function AdminSettings() {
  // The tab lives in the URL so a link can point at one, and reloading keeps your place.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = readTab(searchParams.get("tab"));

  const selectTab = (tab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", tab);
      return next;
    }, { replace: true });
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Settings</h2>
          <p className="text-muted-foreground">Configure application settings</p>
        </div>

        <Tabs value={activeTab} onValueChange={selectTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="general" className="gap-2">
              <SettingsIcon className="w-4 h-4" />
              General
            </TabsTrigger>
            <TabsTrigger value="integrations" className="gap-2">
              <Plug className="w-4 h-4" />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="ai" className="gap-2">
              <Bot className="w-4 h-4" />
              AI
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <GeneralIdentitySettings />
            <ThemeSelector />
            <p className="text-sm text-muted-foreground">
              Looking for email notifications?{" "}
              <Link to="/admin/notifications" className="underline underline-offset-4 hover:text-foreground">
                Manage them on the Notifications page
              </Link>
              .
            </p>
          </TabsContent>

          <TabsContent value="integrations" className="space-y-6">
            <AppCredentialsSettings />
            <TikTokSandboxToggle />
            <TikTokAnalyticsSourceCard />
            <CdnStorageSettings />
            <ScrapingServicesSettings />
          </TabsContent>

          <TabsContent value="ai" className="space-y-6">
            <AIConfigurationTab />
            <AdminAiAgentSection />
            <BrandIntelligenceSettings />
            <HiggsfieldIntegrationCard />
            <UserAiModelOverrides />
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
