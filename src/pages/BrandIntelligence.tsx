import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { SearchCheck, Camera, AtSign, Loader2, Facebook, Video, History, Hash, BarChart3, MessageCircle } from "lucide-react";
import { BrandSearchBar } from "@/components/brand-intelligence/BrandSearchBar";
import { ProfileCard } from "@/components/brand-intelligence/ProfileCard";
import { FilterToolbar } from "@/components/brand-intelligence/FilterToolbar";
import { PostsGrid } from "@/components/brand-intelligence/PostsGrid";
import { PostDetailDrawer } from "@/components/brand-intelligence/PostDetailDrawer";
import { ScrapeHistory } from "@/components/brand-intelligence/ScrapeHistory";
import { ThreadsDiscoveryPanel } from "@/components/brand-intelligence/ThreadsDiscoveryPanel";
import { ThreadsKeywordSearchPanel } from "@/components/brand-intelligence/ThreadsKeywordSearchPanel";
import { ThreadsInsightsPanel } from "@/components/brand-intelligence/ThreadsInsightsPanel";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { useBrandScrape } from "@/hooks/useBrandScrape";
import { useUserRole } from "@/hooks/useUserRole";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import type { BrandPost, BrandScrapeFilters, BrandPlatform } from "@/types/brand-intelligence";

const DEFAULT_FILTERS: BrandScrapeFilters = {
  sortBy: "engagement",
  mediaType: "all",
  period: "all",
  minEngagement: 0,
};

const EXAMPLE_BRANDS = ["@nike", "@cocacola", "@redbull", "@apple"];

export default function BrandIntelligence() {
  const { t } = useTranslation("analytics");
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useAuth();
  const { isAdmin } = useUserRole();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const [topTab, setTopTab] = useState<"brand-intelligence" | "messaging">(
    (location.state as any)?.openTab === "messaging" ? "messaging" : "brand-intelligence"
  );
  const [activeTab, setActiveTab] = useState<BrandPlatform | "history">("instagram");
  const [threadsMode, setThreadsMode] = useState<"analyze" | "discovery" | "keyword_search" | "insights">("analyze");
  const [filters, setFilters] = useState<BrandScrapeFilters>(DEFAULT_FILTERS);
  const [selectedPost, setSelectedPost] = useState<BrandPost | null>(null);
  const { profile, posts, totalPosts, hasMore, isLoading, error, search, loadMore, loadFromSession, reset } = useBrandScrape();

  // Fetch post IDs that have cached AI content
  const { data: contentPostIds = new Set<string>() } = useQuery({
    queryKey: ["bi-content-post-ids", session?.user?.id],
    queryFn: async () => {
      if (!session?.user?.id) return new Set<string>();
      const { data } = await supabase
        .from("bi_post_content")
        .select("post_id")
        .eq("user_id", session.user.id);
      return new Set((data || []).map((d: { post_id: string }) => d.post_id));
    },
    enabled: !!session?.user?.id,
  });

  useEffect(() => {
    if (!flagsLoading && !isAdmin && !flags.brandIntelligence) {
      navigate("/dashboard", { replace: true });
    }
  }, [flagsLoading, isAdmin, flags.brandIntelligence, navigate]);

  const handleSearch = (username: string) => {
    if (activeTab === "history") return;
    search(username, activeTab as BrandPlatform);
  };

  const handlePostClick = (post: BrandPost) => {
    if (post.mediaType === "VIDEO" || post.mediaType === "REEL") {
      navigate(`/brand-intelligence/post/${post.id}`, {
        state: { post, platform: activeTab, username: profile?.username },
      });
    } else {
      setSelectedPost(post);
    }
  };

  const handleTabChange = (tab: string) => {
    const newTab = tab as BrandPlatform | "history";
    setActiveTab(newTab);
    if (newTab !== "history") {
      reset();
    }
  };

  const filteredPosts = useMemo(() => {
    let result = [...posts];

    if (filters.mediaType !== "all") {
      const typeMap: Record<string, string[]> = {
        image: ["IMAGE"],
        video: ["VIDEO"],
        reel: ["REEL"],
        carousel: ["CAROUSEL"],
      };
      result = result.filter((p) => typeMap[filters.mediaType]?.includes(p.mediaType));
    }

    if (filters.period !== "all") {
      const now = Date.now();
      const ms: Record<string, number> = {
        "30d": 30 * 86400000,
        "3m": 90 * 86400000,
        "6m": 180 * 86400000,
        "1y": 365 * 86400000,
      };
      const cutoff = now - (ms[filters.period] || 0);
      result = result.filter((p) => new Date(p.timestamp).getTime() > cutoff);
    }

    if (filters.minEngagement > 0) {
      result = result.filter((p) => p.engagementScore >= filters.minEngagement);
    }

    const sorters: Record<string, (a: BrandPost, b: BrandPost) => number> = {
      engagement: (a, b) => b.engagementScore - a.engagementScore,
      likes: (a, b) => b.likesCount - a.likesCount,
      comments: (a, b) => b.commentsCount - a.commentsCount,
      views: (a, b) => (b.videoViewCount || 0) - (a.videoViewCount || 0),
      shares: (a, b) => (b.sharesCount || 0) - (a.sharesCount || 0),
      saves: (a, b) => (b.savesCount || 0) - (a.savesCount || 0),
      newest: (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      oldest: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    };
    result.sort(sorters[filters.sortBy] || sorters.engagement);

    return result;
  }, [posts, filters]);

  const maxEngagement = useMemo(() => Math.max(...posts.map((p) => p.engagementScore), 0), [posts]);
  const hasResults = profile !== null;

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-neutral-900 dark:bg-neutral-800">
              <SearchCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{t("brand.topTitle", "Social Media")}</h1>
              <p className="text-sm text-muted-foreground">{t("brand.subtitle", "Analyze brands & manage conversations")}</p>
            </div>
          </div>
        </div>

        {/* Top-level Tabs */}
        <Tabs value={topTab} onValueChange={(v) => setTopTab(v as "brand-intelligence" | "messaging")}>
          <TabsList>
            <TabsTrigger value="brand-intelligence" className="gap-1.5">
              <SearchCheck className="w-4 h-4" />
              {t("brand.title", "Brand Intelligence")}
            </TabsTrigger>
            <TabsTrigger value="messaging" className="gap-1.5">
              <MessageCircle className="w-4 h-4" />
              {t("brand.messaging", "Messaging")}
            </TabsTrigger>
          </TabsList>

          {/* Brand Intelligence Tab */}
          <TabsContent value="brand-intelligence" className="mt-4">

        {/* Platform Tabs */}
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="instagram" className="gap-1.5">
              <Camera className="w-4 h-4" />
              <span className={activeTab === "instagram" ? "text-foreground" : ""}>
                {t("brand.instagram", "Instagram")}
              </span>
            </TabsTrigger>
            <TabsTrigger value="threads" className="gap-1.5">
              <AtSign className="w-4 h-4" />
              {t("brand.threads", "Threads")}
            </TabsTrigger>
            <TabsTrigger value="facebook" className="gap-1.5">
              <Facebook className="w-4 h-4" />
              {t("brand.facebook", "Facebook")}
            </TabsTrigger>
            <TabsTrigger value="tiktok" className="gap-1.5">
              <Video className="w-4 h-4" />
              {t("brand.tiktok", "TikTok")}
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1.5">
              <History className="w-4 h-4" />
              {t("brand.history", "History")}
            </TabsTrigger>
          </TabsList>

          {/* History Tab */}
          <TabsContent value="history" className="mt-4">
            <ScrapeHistory
              onReuse={(p, posts) => {
                loadFromSession(p, posts);
                setActiveTab(p.platform as BrandPlatform | "history");
              }}
            />
          </TabsContent>

          {/* Non-Threads Platform Tabs Content */}
          {["instagram", "facebook", "tiktok"].map((tab) => (
            <TabsContent key={tab} value={tab} className="mt-4 space-y-4">
              <BrandSearchBar platform={activeTab as BrandPlatform} onSearch={handleSearch} isLoading={isLoading} />

              {error && (
                <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {hasResults && (
                <div className="space-y-4">
                  <ProfileCard profile={profile!} isLoading={isLoading} />
                  <FilterToolbar filters={filters} onChange={setFilters} maxEngagement={maxEngagement} />
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      {t("posts.countOf", "{{filtered}} of {{total}} posts", { filtered: filteredPosts.length, total: totalPosts })}
                    </p>
                  </div>
                  <PostsGrid posts={filteredPosts} isLoading={isLoading} onPostClick={handlePostClick} contentPostIds={contentPostIds} />
                  {hasMore && (
                    <div className="flex justify-center pt-4">
                      <Button variant="outline" onClick={loadMore} className="gap-2">
                        <Loader2 className="w-4 h-4" />
                        {t("actions.loadMore", "Load More")}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {!hasResults && !isLoading && !error && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-4 bg-muted">
                    <SearchCheck className="w-10 h-10 text-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold mb-1">{t("empty.searchBrand", "Start by searching for a brand")}</h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-md">
                    {tab === "tiktok"
                      ? t("empty.searchHintTiktok", "Enter any TikTok username to analyze their top performing content")
                      : tab === "facebook"
                        ? t("empty.searchHintFacebook", "Enter any Facebook page username to analyze their top performing content")
                        : t("empty.searchHintInstagram", "Enter any Instagram username to analyze their top performing content")}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {EXAMPLE_BRANDS.map((brand) => (
                      <Button
                        key={brand}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => handleSearch(brand.replace("@", ""))}
                      >
                        {brand}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>
          ))}

          {/* Threads Tab with Sub-Sections */}
          <TabsContent value="threads" className="mt-4 space-y-4">
            <div className="flex gap-2 border-b pb-2 flex-wrap">
              <Button
                variant={threadsMode === "analyze" ? "default" : "ghost"}
                size="sm"
                onClick={() => setThreadsMode("analyze")}
                className="gap-1.5"
              >
                <SearchCheck className="w-4 h-4" />
                {t("header.analyze", "Analyze")}
              </Button>
              <Button
                variant={threadsMode === "discovery" ? "default" : "ghost"}
                size="sm"
                onClick={() => setThreadsMode("discovery")}
                className="gap-1.5"
              >
                <AtSign className="w-4 h-4" />
                {t("header.discovery", "Discovery")}
              </Button>
              <Button
                variant={threadsMode === "keyword_search" ? "default" : "ghost"}
                size="sm"
                onClick={() => setThreadsMode("keyword_search")}
                className="gap-1.5"
              >
                <Hash className="w-4 h-4" />
                {t("header.keywordSearch", "Keyword Search")}
              </Button>
              <Button
                variant={threadsMode === "insights" ? "default" : "ghost"}
                size="sm"
                onClick={() => setThreadsMode("insights")}
                className="gap-1.5"
              >
                <BarChart3 className="w-4 h-4" />
                {t("header.insights", "Insights")}
              </Button>
            </div>

            {threadsMode === "analyze" && (
              <div className="space-y-4">
                <BrandSearchBar platform="threads" onSearch={handleSearch} isLoading={isLoading} />

                {error && (
                  <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
                )}

                {hasResults && (
                  <div className="space-y-4">
                    <ProfileCard profile={profile!} isLoading={isLoading} />
                    <FilterToolbar filters={filters} onChange={setFilters} maxEngagement={maxEngagement} />
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        {t("posts.countOf", "{{filtered}} of {{total}} posts", { filtered: filteredPosts.length, total: totalPosts })}
                      </p>
                    </div>
                    <PostsGrid posts={filteredPosts} isLoading={isLoading} onPostClick={handlePostClick} contentPostIds={contentPostIds} />
                    {hasMore && (
                      <div className="flex justify-center pt-4">
                        <Button variant="outline" onClick={loadMore} className="gap-2">
                          <Loader2 className="w-4 h-4" />
                          {t("actions.loadMore", "Load More")}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {!hasResults && !isLoading && !error && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-4 bg-muted">
                      <SearchCheck className="w-10 h-10 text-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold mb-1">{t("empty.searchBrand", "Start by searching for a brand")}</h3>
                    <p className="text-sm text-muted-foreground mb-6 max-w-md">
                      {t("empty.searchHintThreads", "Enter any Threads username to analyze their top performing content")}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {EXAMPLE_BRANDS.map((brand) => (
                        <Button key={brand} variant="outline" size="sm" className="text-xs" onClick={() => handleSearch(brand.replace("@", ""))}>
                          {brand}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {threadsMode === "discovery" && <ThreadsDiscoveryPanel />}
            {threadsMode === "keyword_search" && <ThreadsKeywordSearchPanel />}
            {threadsMode === "insights" && <ThreadsInsightsPanel />}
          </TabsContent>
        </Tabs>
          </TabsContent>

          {/* Messaging Tab */}
          <TabsContent value="messaging" className="mt-4">
            <MessagingInbox />
          </TabsContent>
        </Tabs>

        <PostDetailDrawer
          post={selectedPost}
          isOpen={!!selectedPost}
          onClose={() => setSelectedPost(null)}
        />
      </div>
    </DashboardLayout>
  );
}
