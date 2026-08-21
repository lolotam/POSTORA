import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Video, Loader2, SearchCheck, ShieldCheck, Bot, AlertCircle, Plug } from "lucide-react";
import { BrandSearchBar } from "@/components/brand-intelligence/BrandSearchBar";
import { ProfileCard } from "@/components/brand-intelligence/ProfileCard";
import { FilterToolbar } from "@/components/brand-intelligence/FilterToolbar";
import { PostsGrid } from "@/components/brand-intelligence/PostsGrid";
import { PostDetailDrawer } from "@/components/brand-intelligence/PostDetailDrawer";
import { TikTokAccountSelector } from "@/components/analytics/TikTokAccountSelector";
import { useBrandScrape } from "@/hooks/useBrandScrape";
import { useTikTokAnalyticsSource } from "@/hooks/useTikTokAnalyticsSource";
import { useTikTokApiAnalytics } from "@/hooks/useTikTokApiAnalytics";
import type { BrandPost, BrandScrapeFilters } from "@/types/brand-intelligence";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { cn } from "@/lib/utils";

const DEFAULT_FILTERS: BrandScrapeFilters = {
  sortBy: "engagement",
  mediaType: "all",
  period: "all",
  minEngagement: 0,
};

const EXAMPLE_BRANDS = ["@nike", "@cocacola", "@redbull", "@apple"];

export default function TikTokAnalytics() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [filters, setFilters] = useState<BrandScrapeFilters>(DEFAULT_FILTERS);
  const [selectedPost, setSelectedPost] = useState<BrandPost | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const { source, isLoading: sourceLoading } = useTikTokAnalyticsSource();
  const apifyHook = useBrandScrape();
  const apiHook = useTikTokApiAnalytics(source === "tiktok_api" ? selectedAccountId : null);

  // Auto-select first connected TikTok account when in API mode
  const { data: tiktokAccounts = [] } = useQuery({
    queryKey: ["tiktok-accounts-list", session?.user?.id],
    queryFn: async () => {
      if (!session?.user?.id) return [];
      const { data } = await supabase
        .from("social_accounts")
        .select("id")
        .eq("user_id", session.user.id)
        .eq("platform", "tiktok")
        .eq("is_active", true);
      return data || [];
    },
    enabled: !!session?.user?.id && source === "tiktok_api",
  });

  useEffect(() => {
    if (source === "tiktok_api" && !selectedAccountId && tiktokAccounts[0]?.id) {
      setSelectedAccountId(tiktokAccounts[0].id);
    }
  }, [source, selectedAccountId, tiktokAccounts]);

  // Pick which hook drives the page
  const isApi = source === "tiktok_api";
  const profile = isApi ? apiHook.profile : apifyHook.profile;
  const posts = isApi ? apiHook.posts : apifyHook.posts;
  const totalPosts = isApi ? apiHook.totalPosts : apifyHook.totalPosts;
  const hasMore = isApi ? apiHook.hasMore : apifyHook.hasMore;
  const isLoading = isApi ? apiHook.isLoading : apifyHook.isLoading;
  const error = isApi ? apiHook.error : apifyHook.error;
  const errorCode = isApi ? apiHook.errorCode : undefined;
  const loadMore = isApi ? apiHook.loadMore : apifyHook.loadMore;

  const { data: contentPostIds = new Set<string>() } = useQuery({
    queryKey: ["bi-content-post-ids", session?.user?.id],
    queryFn: async () => {
      if (!session?.user?.id) return new Set<string>();
      const { data } = await supabase.from("bi_post_content").select("post_id").eq("user_id", session.user.id);
      return new Set((data || []).map((d: { post_id: string }) => d.post_id));
    },
    enabled: !!session?.user?.id,
  });

  const handleSearch = (username: string) => apifyHook.search(username, "tiktok");

  const handlePostClick = (post: BrandPost) => {
    if (post.mediaType === "VIDEO" || post.mediaType === "REEL") {
      navigate(`/brand-intelligence/post/${post.id}`, { state: { post, platform: "tiktok", username: profile?.username } });
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
    if (filters.minEngagement > 0) result = result.filter((p) => p.engagementScore >= filters.minEngagement);
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

  const renderErrorBlock = () => {
    if (!error) return null;
    if (errorCode === "scope_missing") {
      return (
        <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-rose-500">
            <AlertCircle className="w-4 h-4" /> Missing TikTok permissions
          </div>
          <p className="text-xs text-muted-foreground">
            This account is missing the <code className="px-1 rounded bg-background/50">user.info.stats</code> or{" "}
            <code className="px-1 rounded bg-background/50">video.list</code> scope. Please reconnect TikTok to grant the
            new permissions.
          </p>
          <Button size="sm" variant="outline" className="border-rose-500/40 hover:bg-rose-500/10" onClick={() => navigate("/profiles")}>
            <Plug className="w-3.5 h-3.5 mr-2" /> Reconnect TikTok
          </Button>
        </GradientRingCard>
      );
    }
    if (errorCode === "token_expired") {
      return (
        <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-rose-500">
            <AlertCircle className="w-4 h-4" /> TikTok token expired
          </div>
          <p className="text-xs text-muted-foreground">Please reconnect this TikTok account to refresh your access.</p>
          <Button size="sm" variant="outline" className="border-rose-500/40 hover:bg-rose-500/10" onClick={() => navigate("/profiles")}>
            <Plug className="w-3.5 h-3.5 mr-2" /> Reconnect TikTok
          </Button>
        </GradientRingCard>
      );
    }
    if (errorCode === "sandbox_user_not_added") {
      return (
        <GradientRingCard variant="amber" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
          <div className="flex items-center gap-2 font-semibold mb-1 text-amber-500">
            <AlertCircle className="w-4 h-4" /> Sandbox restriction
          </div>
          <p className="text-xs text-muted-foreground">
            Your TikTok app is in Sandbox mode and this user has not been added as a test user. Add them in the TikTok
            Developer Portal → Sandbox → Test Users.
          </p>
        </GradientRingCard>
      );
    }
    return (
      <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
        <p className="text-sm text-rose-500">{error}</p>
      </GradientRingCard>
    );
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="group flex items-center gap-4">
            <Icon3D icon={Video} variant="rose" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="amber-rose-violet" size="lg" as="h1">TikTok Analytics</GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">Analyze TikTok creators & top performing content</p>
            </div>
            {!sourceLoading && (
              <Badge
                variant="outline"
                className={cn(
                  "backdrop-blur-md bg-card/60",
                  isApi
                    ? "border-cyan-500/40 text-cyan-500"
                    : "border-amber-500/40 text-amber-500",
                )}
              >
                {isApi ? <ShieldCheck className="w-3 h-3 mr-1" /> : <Bot className="w-3 h-3 mr-1" />}
                {isApi ? "Official TikTok API" : "Apify Scraper"}
              </Badge>
            )}
          </div>
        </Reveal>
        <GradientDivider tone="rose" />

        <div className="space-y-4">
          {/* Search / account selector */}
          <Reveal delay={80}>
            {isApi ? (
              tiktokAccounts.length > 0 ? (
                <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                  <TikTokAccountSelector value={selectedAccountId} onChange={setSelectedAccountId} />
                </GradientRingCard>
              ) : <div />
            ) : (
              <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <BrandSearchBar platform="tiktok" onSearch={handleSearch} isLoading={isLoading} />
              </GradientRingCard>
            )}
          </Reveal>

          {renderErrorBlock()}

          {hasResults && (
            <Reveal delay={120} className="space-y-4">
              <ProfileCard profile={profile!} isLoading={isLoading} />
              <FilterToolbar filters={filters} onChange={setFilters} maxEngagement={maxEngagement} />
              <p className="text-sm text-muted-foreground">{filteredPosts.length} of {totalPosts} posts</p>
              <PostsGrid posts={filteredPosts} isLoading={isLoading} onPostClick={handlePostClick} contentPostIds={contentPostIds} />
              {hasMore && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" onClick={loadMore} className="gap-2 border-rose-500/40 hover:bg-rose-500/10" disabled={isLoading}>
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Loader2 className="w-4 h-4" />}
                    Load More
                  </Button>
                </div>
              )}
            </Reveal>
          )}

          {/* Empty states */}
          {!hasResults && !isLoading && !error && isApi && tiktokAccounts.length === 0 && (
            <Reveal delay={140}>
              <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle">
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="group mb-5"><Icon3D icon={Plug} variant="rose" size="lg" /></div>
                  <h3 className="text-lg font-semibold mb-1">Connect a TikTok account</h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-md">
                    Official TikTok API mode is active. Connect a TikTok account to view its real analytics.
                  </p>
                  <Button onClick={() => navigate("/profiles")} className="bg-gradient-to-r from-rose-500 via-pink-500 to-fuchsia-500 text-white hover:opacity-90">
                    <Plug className="w-4 h-4 mr-2" /> Connect TikTok
                  </Button>
              </div>
              </GradientRingCard>
            </Reveal>
          )}

          {!hasResults && !isLoading && !error && !isApi && (
            <Reveal delay={140}>
              <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle">
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="group mb-5"><Icon3D icon={SearchCheck} variant="rose" size="lg" /></div>
                  <h3 className="text-lg font-semibold mb-1">Start by searching for a creator</h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-md">Enter any TikTok username to analyze their top performing content</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {EXAMPLE_BRANDS.map((brand) => (
                      <Button key={brand} variant="outline" size="sm" className="text-xs border-rose-500/40 hover:bg-rose-500/10 transition-transform hover:-translate-y-0.5" onClick={() => handleSearch(brand.replace("@", ""))}>{brand}</Button>
                    ))}
                  </div>
                </div>
              </GradientRingCard>
            </Reveal>
          )}
        </div>

        <PostDetailDrawer post={selectedPost} isOpen={!!selectedPost} onClose={() => setSelectedPost(null)} />
      </div>
    </DashboardLayout>
  );
}
