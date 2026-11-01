import { compareBrandMetric } from "@/lib/brandMetrics";
import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Camera, Loader2, SearchCheck, TrendingUp, Target } from "lucide-react";
import { BrandSearchBar } from "@/components/brand-intelligence/BrandSearchBar";
import { ProfileCard } from "@/components/brand-intelligence/ProfileCard";
import { FilterToolbar } from "@/components/brand-intelligence/FilterToolbar";
import { PostsGrid } from "@/components/brand-intelligence/PostsGrid";
import { PostDetailDrawer } from "@/components/brand-intelligence/PostDetailDrawer";
import { useBrandScrape } from "@/hooks/useBrandScrape";
import type { BrandPost, BrandScrapeFilters } from "@/types/brand-intelligence";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { InstagramPerformanceScreen } from "@/features/instagram-insights";
import { CompetitorTrackingScreen, TrackCompetitorControl } from "@/features/competitor-tracking";

const DEFAULT_FILTERS: BrandScrapeFilters = {
  sortBy: "engagement",
  mediaType: "all",
  period: "all",
  minEngagement: 0,
};

const EXAMPLE_BRANDS = ["@nike", "@cocacola", "@redbull", "@apple"];

const VALID_TABS = ["performance", "analyze", "competitors"] as const;
export type InstagramAnalyticsTab = (typeof VALID_TABS)[number];

/**
 * Whether a query names a tab of this page.
 *
 * An unknown tab is not an error: the page falls back to its default
 * tab and rewrites the query, so a stale bookmark still lands on a
 * working page.
 */
function isAnalyticsTab(value: string | null): value is InstagramAnalyticsTab {
  return value !== null && (VALID_TABS as readonly string[]).includes(value);
}

export type InstagramAnalyticsProps = {
  defaultTab?: InstagramAnalyticsTab;
};

export default function InstagramAnalytics({ defaultTab = "performance" }: InstagramAnalyticsProps) {
  const { t } = useTranslation("analytics");
  const navigate = useNavigate();
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * THE URL IS THE STATE OF THIS PAGE.
   *
   * The active tab is read from the query every render instead of
   * being copied into local state. A tab the owner clicks, a history
   * entry the owner walks back to and a query the owner edits all
   * reconcile the same way, because there is only one place the tab
   * lives (spec §2).
   */
  const tabParam = searchParams.get("tab");
  const activeTab: InstagramAnalyticsTab = isAnalyticsTab(tabParam) ? tabParam : defaultTab;

  /**
   * A missing or unknown tab is normalised in place.
   *
   * The rewrite REPLACES the history entry: it is the same page, and
   * the owner should be able to go back to wherever they came from.
   */
  useEffect(() => {
    if (tabParam === activeTab) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", activeTab);
    setSearchParams(next, { replace: true });
  }, [activeTab, tabParam, searchParams, setSearchParams]);

  /**
   * Choosing a tab is a navigation.
   *
   * It PUSHES a history entry, so the browser's back button walks
   * through the tabs the owner visited instead of leaving the page.
   */
  const selectTab = (tab: InstagramAnalyticsTab) => {
    if (tab === activeTab) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next);
  };

  const [filters, setFilters] = useState<BrandScrapeFilters>(DEFAULT_FILTERS);
  const [selectedPost, setSelectedPost] = useState<BrandPost | null>(null);
  const { profile, profileSource, posts, totalPosts, hasMore, isLoading, error, warning, reconnectRequired, search, loadMore } = useBrandScrape(session?.user.id);

  const { data: contentPostIds = new Set<string>() } = useQuery({
    queryKey: ["bi-content-post-ids", session?.user?.id],
    queryFn: async () => {
      if (!session?.user?.id) return new Set<string>();
      const { data } = await supabase.from("bi_post_content").select("post_id").eq("user_id", session.user.id);
      return new Set((data || []).map((d: { post_id: string }) => d.post_id));
    },
    enabled: !!session?.user?.id,
  });

  const handleSearch = (username: string) => search(username, "instagram");

  const handlePostClick = (post: BrandPost) => {
    if (post.mediaType === "VIDEO" || post.mediaType === "REEL") {
      navigate(`/brand-intelligence/post/${post.id}`, { state: { post, platform: "instagram", username: profile?.username } });
    } else {
      setSelectedPost(post);
    }
  };

  const filteredPosts = useMemo(() => {
    let result = [...posts];
    if (filters.mediaType !== "all") {
      const typeMap: Record<string, string[]> = { image: ["IMAGE"], video: ["VIDEO"], reel: ["REEL"], carousel: ["CAROUSEL"] };
      result = result.filter((p) => typeMap[filters.mediaType]?.includes(p.mediaType));
    }
    if (filters.period !== "all") {
      const now = Date.now();
      const ms: Record<string, number> = { "30d": 30 * 86400000, "3m": 90 * 86400000, "6m": 180 * 86400000, "1y": 365 * 86400000 };
      result = result.filter((p) => new Date(p.timestamp).getTime() > now - (ms[filters.period] || 0));
    }
    if (filters.minEngagement > 0) result = result.filter((p) => p.engagementScore !== null && p.engagementScore >= filters.minEngagement);
    const sorters: Record<string, (a: BrandPost, b: BrandPost) => number> = {
      engagement: (a, b) => compareBrandMetric(a, b, "engagementScore"),
      likes: (a, b) => compareBrandMetric(a, b, "likesCount"),
      comments: (a, b) => compareBrandMetric(a, b, "commentsCount"),
      views: (a, b) => compareBrandMetric(a, b, "videoViewCount"),
      shares: (a, b) => compareBrandMetric(a, b, "sharesCount"),
      saves: (a, b) => compareBrandMetric(a, b, "savesCount"),
      newest: (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      oldest: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    };
    result.sort(sorters[filters.sortBy] || sorters.engagement);
    return result;
  }, [posts, filters]);

  const maxEngagement = useMemo(() => Math.max(...posts.flatMap((p) => p.engagementScore === null ? [] : [p.engagementScore]), 0), [posts]);
  const hasResults = profile !== null;

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="group flex items-center gap-4">
            <Icon3D icon={Camera} variant="rose" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="amber-rose-violet" size="lg" as="h1">
                {t("header.instagram", "Instagram Analytics")}
              </GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">
                {activeTab === "performance"
                  ? t("header.instagramPerformanceSubtitle", "Track owned account performance, daily insights & outlier reach")
                  : activeTab === "competitors"
                    ? t("competitors.tabHint", "Track Instagram competitors and compare their public history")
                    : t("header.instagramSubtitle", "Analyze Instagram brands & top performing content")}
              </p>
            </div>
          </div>
        </Reveal>

        {/*
          The switcher hugs its content on a wide screen and takes the
          full width on a narrow one, so the third tab wraps instead of
          pushing the page sideways.
        */}
        <div className="flex items-center gap-2 p-1 bg-muted/40 rounded-xl border border-border/60 w-full sm:w-fit flex-wrap">
          <Button
            type="button"
            size="sm"
            variant={activeTab === "performance" ? "secondary" : "ghost"}
            onClick={() => selectTab("performance")}
            className={`gap-2 text-xs font-medium rounded-lg h-8 px-3.5 transition-all ${
              activeTab === "performance" ? "bg-background shadow-xs text-foreground font-semibold" : "text-muted-foreground"
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5 text-rose-500" />
            <span>{t("instagram.tabPerformance", "Performance & Insights")}</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant={activeTab === "analyze" ? "secondary" : "ghost"}
            onClick={() => selectTab("analyze")}
            className={`gap-2 text-xs font-medium rounded-lg h-8 px-3.5 transition-all ${
              activeTab === "analyze" ? "bg-background shadow-xs text-foreground font-semibold" : "text-muted-foreground"
            }`}
          >
            <SearchCheck className="h-3.5 w-3.5 text-amber-500" />
            <span>{t("instagram.tabCompetitors", "Brand & Competitors")}</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant={activeTab === "competitors" ? "secondary" : "ghost"}
            onClick={() => selectTab("competitors")}
            className={`gap-2 text-xs font-medium rounded-lg h-8 px-3.5 transition-all ${
              activeTab === "competitors" ? "bg-background shadow-xs text-foreground font-semibold" : "text-muted-foreground"
            }`}
          >
            <Target className="h-3.5 w-3.5 text-violet-500" />
            <span>{t("competitors.tab", "Tracked competitors")}</span>
          </Button>
        </div>

        <GradientDivider tone="rose" />

        {activeTab === "performance" ? (
          <Reveal delay={60}>
            <InstagramPerformanceScreen />
          </Reveal>
        ) : activeTab === "competitors" ? (
          <Reveal delay={60}>
            <CompetitorTrackingScreen />
          </Reveal>
        ) : (
          <>
            <Reveal delay={80}>
              <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <BrandSearchBar platform="instagram" onSearch={handleSearch} isLoading={isLoading} />
              </GradientRingCard>
            </Reveal>

            {(error || warning) && (
              <Reveal delay={120}>
                <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
                  <p className="text-sm text-rose-500">{error || warning}</p>
                  {reconnectRequired && <Button variant="outline" className="mt-3" onClick={() => navigate("/profiles")}>
                    {t("actions.reconnectInstagram", "Reconnect Instagram")}
                  </Button>}
                </GradientRingCard>
              </Reveal>
            )}

            {hasResults && (
              <Reveal delay={160}>
                <div className="space-y-4">
                  <ProfileCard
                    profile={profile!}
                    isLoading={isLoading}
                    source={profileSource}
                    actions={<TrackCompetitorControl username={profile!.username} />}
                  />
                  <FilterToolbar filters={filters} onChange={setFilters} maxEngagement={maxEngagement} />
                  <p className="text-sm text-muted-foreground">
                    {t("posts.countOf", "{{filtered}} of {{total}} posts", {
                      filtered: filteredPosts.length,
                      total: totalPosts,
                    })}
                  </p>
                  <PostsGrid posts={filteredPosts} isLoading={isLoading} onPostClick={handlePostClick} contentPostIds={contentPostIds} />
                  {hasMore && (
                    <div className="flex justify-center pt-4">
                      <Button variant="outline" onClick={loadMore} className="gap-2 border-rose-500/40 hover:bg-rose-500/10">
                        <Loader2 className="w-4 h-4" />
                        {t("actions.loadMore", "Load More")}
                      </Button>
                    </div>
                  )}
                </div>
              </Reveal>
            )}

            {!hasResults && !isLoading && !error && (
              <Reveal delay={160}>
                <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle">
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="group mb-5">
                      <Icon3D icon={SearchCheck} variant="rose" size="lg" />
                    </div>
                    <h3 className="text-lg font-semibold mb-1">
                      {t("empty.searchBrand", "Start by searching for a brand")}
                    </h3>
                    <p className="text-sm text-muted-foreground mb-6 max-w-md">
                      {t("empty.searchHintInstagram", "Enter any Instagram username to analyze their top performing content")}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {EXAMPLE_BRANDS.map((brand) => (
                        <Button
                          key={brand}
                          variant="outline"
                          size="sm"
                          className="text-xs border-rose-500/40 hover:bg-rose-500/10 transition-transform hover:-translate-y-0.5"
                          onClick={() => handleSearch(brand.replace("@", ""))}
                        >
                          {brand}
                        </Button>
                      ))}
                    </div>
                  </div>
                </GradientRingCard>
              </Reveal>
            )}

            <PostDetailDrawer post={selectedPost} isOpen={!!selectedPost} onClose={() => setSelectedPost(null)} />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
