import type { ComponentType } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Plug, Settings as SettingsIcon } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AIConfigurationTab } from "@/pages/admin/AIConfigurationTab";
import { UserAiModelOverrides } from "@/components/admin/UserAiModelOverrides";
import { ThemeSelector } from "@/components/admin/ThemeSelector";
import { BrandIntelligenceSettings } from "@/components/admin/BrandIntelligenceSettings";
import { ScrapingServicesSettings } from "@/components/admin/ScrapingServicesSettings";
import { AppCredentialsSettings } from "@/components/admin/AppCredentialsSettings";
import { AdminAiAgentSection } from "@/components/admin/AdminAiAgentSection";
import { TikTokAnalyticsSourceCard } from "@/components/admin/settings/TikTokAnalyticsSourceCard";
import { CdnStorageSettings } from "@/components/admin/settings/CdnStorageSettings";
import { HiggsfieldIntegrationCard } from "@/components/admin/settings/HiggsfieldIntegrationCard";
import { GeneralIdentitySettings } from "@/components/admin/settings/GeneralIdentitySettings";
import { TikTokSandboxToggle } from "@/components/admin/settings/TikTokSandboxToggle";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/admin/settings/settingsCatalog";
import { SettingsSearchBar } from "@/components/admin/settings/SettingsSearchBar";
import {
  countMatchesByTab,
  readSettingsTab,
  searchSettings,
  SETTINGS_TAB_LABELS,
  SETTINGS_TABS,
} from "@/lib/settingsSearch";

/**
 * Binds each catalogued section to what renders it. Typed as a total record over the
 * catalog's ids, so adding a section without a component — or leaving a component
 * behind after removing one — fails the build rather than the page.
 */
const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  "identity": GeneralIdentitySettings,
  "theme": ThemeSelector,
  "app-credentials": AppCredentialsSettings,
  "tiktok-sandbox": TikTokSandboxToggle,
  "tiktok-analytics-source": TikTokAnalyticsSourceCard,
  "cdn-storage": CdnStorageSettings,
  "scraping-services": ScrapingServicesSettings,
  "ai-configuration": AIConfigurationTab,
  "ai-agent-models": AdminAiAgentSection,
  "brand-intelligence": BrandIntelligenceSettings,
  "higgsfield": HiggsfieldIntegrationCard,
  "user-ai-overrides": UserAiModelOverrides,
};

const TAB_ICONS = {
  general: SettingsIcon,
  integrations: Plug,
  ai: Bot,
} as const;

export default function AdminSettings() {
  // Tab and query both live in the URL, so a search can be linked and a reload keeps
  // your place. Every write merges into the existing params rather than replacing them.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = readSettingsTab(searchParams.get("tab"));
  const query = searchParams.get("q") ?? "";

  const setParam = (key: string, value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const matches = searchSettings(SETTINGS_SECTIONS, query);
  const counts = countMatchesByTab(matches);
  const isSearching = query.trim().length > 0;

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Settings</h2>
          <p className="text-muted-foreground">Configure application settings</p>
        </div>

        <SettingsSearchBar
          query={query}
          onQueryChange={(value) => setParam("q", value)}
          counts={counts}
          totalMatches={matches.length}
          activeTab={activeTab}
          onSelectTab={(tab) => setParam("tab", tab)}
        />

        <Tabs value={activeTab} onValueChange={(tab) => setParam("tab", tab)} className="space-y-6">
          <TabsList>
            {SETTINGS_TABS.map((tab) => {
              const Icon = TAB_ICONS[tab];
              return (
                <TabsTrigger key={tab} value={tab} className="gap-2">
                  <Icon className="w-4 h-4" />
                  {SETTINGS_TAB_LABELS[tab]}
                  {isSearching && counts[tab] > 0 && (
                    <Badge variant="secondary" className="ml-1 px-1.5">
                      {counts[tab]}
                    </Badge>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {SETTINGS_TABS.map((tab) => {
            const matchedIds = new Set(matches.map((section) => section.id));
            return (
              <TabsContent key={tab} value={tab} className="space-y-6">
                {/* Non-matches are hidden, not unmounted: unmounting a section while
                    someone filters would throw away its unsaved local edits. */}
                {SETTINGS_SECTIONS.filter((section) => section.tab === tab).map(({ id }) => {
                  const Section = SECTION_COMPONENTS[id];
                  return (
                    <div key={id} className={matchedIds.has(id) ? undefined : "hidden"}>
                      <Section />
                    </div>
                  );
                })}

                {counts[tab] === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Nothing in {SETTINGS_TAB_LABELS[tab]} matches “{query}”.
                  </p>
                )}

                {tab === "general" && !isSearching && (
                  <p className="text-sm text-muted-foreground">
                    Looking for email notifications?{" "}
                    <Link to="/admin/notifications" className="underline underline-offset-4 hover:text-foreground">
                      Manage them on the Notifications page
                    </Link>
                    .
                  </p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </div>
    </AdminLayout>
  );
}
