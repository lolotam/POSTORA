import type { ComponentType } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Plug, Settings as SettingsIcon } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { AiProvidersCard } from "@/components/admin/settings/ai/AiProvidersCard";
import {
  ChatModelsCard,
  EmbeddingModelsCard,
  ImageGenerationCard,
  SearchModelsCard,
  SpeechToTextCard,
  TextToSpeechCard,
  VideoGenerationCard,
} from "@/components/admin/settings/ai/AiCategoryCards";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/admin/settings/settingsCatalog";
import { SettingsSearchBar } from "@/components/admin/settings/SettingsSearchBar";
import { SettingsSubTabs } from "@/components/admin/settings/SettingsSubTabs";
import {
  countMatchesByTab,
  groupSectionsBySubTab,
  readSettingsTab,
  resolveSubTab,
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
  "ai-search-models": SearchModelsCard,
  "ai-embedding-models": EmbeddingModelsCard,
  "ai-agent-models": AdminAiAgentSection,
  "ai-stt-models": SpeechToTextCard,
  "ai-tts-models": TextToSpeechCard,
  "ai-video-models": VideoGenerationCard,
  "ai-chat-models": ChatModelsCard,
  "ai-image-models": ImageGenerationCard,
  "ai-providers": AiProvidersCard,
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
  // Tab, sub-tab and query all live in the URL, so a search can be linked and a reload
  // keeps your place. Every write merges into the existing params rather than replacing
  // them.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = readSettingsTab(searchParams.get("tab"));
  const query = searchParams.get("q") ?? "";
  const requestedSubTab = searchParams.get("sub");

  const setParams = (updates: Record<string, string>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(updates)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  };

  const matches = searchSettings(SETTINGS_SECTIONS, query);
  const counts = countMatchesByTab(matches);
  const isSearching = query.trim().length > 0;
  const matchedIds = new Set(matches.map((section) => section.id));

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Settings</h2>
          <p className="text-muted-foreground">Configure application settings</p>
        </div>

        <SettingsSearchBar
          query={query}
          onQueryChange={(value) => setParams({ q: value })}
          counts={counts}
          totalMatches={matches.length}
          activeTab={activeTab}
          onSelectTab={(tab) => setParams({ tab, sub: "" })}
        />

        <Tabs
          value={activeTab}
          // A sub-tab label belongs to the tab it came from, so switching tabs drops it
          // rather than carrying a name the new tab has never heard of.
          onValueChange={(tab) => setParams({ tab, sub: "" })}
          className="space-y-6"
        >
          <TabsList>
            {SETTINGS_TABS.map((tab) => {
              const Icon = TAB_ICONS[tab];
              return (
                <TabsTrigger key={tab} value={tab} className="gap-2">
                  <Icon className="w-4 h-4" />
                  {SETTINGS_TAB_LABELS[tab]}
                  {isSearching && counts[tab] > 0 && (
                    <Badge variant="secondary" className="ms-1 px-1.5">
                      {counts[tab]}
                    </Badge>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {SETTINGS_TABS.map((tab) => {
            const { subTabs, ungrouped } = groupSectionsBySubTab(
              SETTINGS_SECTIONS.filter((section) => section.tab === tab),
            );
            // A search that rules out every section behind a sub-tab hides the sub-tab
            // too, so the strip only offers panels with something in them.
            const visibleSubTabs = subTabs.filter((group) =>
              group.sections.some((section) => matchedIds.has(section.id)),
            );
            const activeSubTab = resolveSubTab(
              visibleSubTabs.map((group) => group.label),
              requestedSubTab,
            );

            return (
              <TabsContent key={tab} value={tab} className="space-y-6">
                {/* Every panel is built and stays mounted; a search only takes away the
                    triggers. That way filtering does not discard what a card was holding
                    unsaved, and clearing the query puts it back untouched. */}
                <SettingsSubTabs
                  active={activeSubTab}
                  onSelect={(label) => setParams({ sub: label })}
                  items={subTabs.map((group) => ({
                    label: group.label,
                    offered: group.sections.some((section) => matchedIds.has(section.id)),
                    content: (
                      <div className="space-y-6">
                        {group.sections.map(({ id }) => {
                          const Section = SECTION_COMPONENTS[id];
                          return (
                            <div key={id} className={matchedIds.has(id) ? undefined : "hidden"}>
                              <Section />
                            </div>
                          );
                        })}
                      </div>
                    ),
                  }))}
                />

                {ungrouped.map(({ id }) => {
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
