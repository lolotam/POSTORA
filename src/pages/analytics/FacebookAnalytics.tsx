import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Facebook, Loader2, SearchCheck, Settings, AlertTriangle } from "lucide-react";
import { BrandSearchBar } from "@/components/brand-intelligence/BrandSearchBar";
import { ProfileCard } from "@/components/brand-intelligence/ProfileCard";
import { FilterToolbar } from "@/components/brand-intelligence/FilterToolbar";
import { PostsGrid } from "@/components/brand-intelligence/PostsGrid";
import { PostDetailDrawer } from "@/components/brand-intelligence/PostDetailDrawer";
import { useBrandScrape } from "@/hooks/useBrandScrape";
import type { BrandPost, BrandScrapeFilters } from "@/types/brand-intelligence";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";

const DEFAULT_FILTERS: BrandScrapeFilters = {
  sortBy: "engagement",
  mediaType: "all",
  period: "all",
  minEngagement: 0,
};

const EXAMPLE_BRANDS = ["@nike", "@cocacola", "@redbull", "@apple"];

export default function FacebookAnalytics() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [filters, setFilters] = useState<BrandScrapeFilters>(DEFAULT_FILTERS);
  const [selectedPost, setSelectedPost] = useState<BrandPost | null>(null);
  const { profile, posts, totalPosts, hasMore, isLoading, error, search, loadMore, reset } = useBrandScrape();

  const { data: contentPostIds = new Set<string>() } = useQuery({
    queryKey: ["bi-content-post-ids", session?.user?.id],
    queryFn: async () => {
      if (!session?.user?.id) return new Set<string>();
      const { data } = await supabase.from("bi_post_content").select("post_id").eq("user_id", session.user.id);
      return new Set((data || []).map((d: { post_id: string }) => d.post_id));
    },
    enabled: !!session?.user?.id,
  });

  const handleSearch = (username: string) => search(username, "facebook");

  const handlePostClick = (post: BrandPost) => {
    if (post.mediaType === "VIDEO" || post.mediaType === "REEL") {
      navigate(`/brand-intelligence/post/${post.id}`, { state: { post, platform: "facebook", username: profile?.username } });
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

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-6">
        <Reveal>
          <div className="group flex items-center gap-4">
            <Icon3D icon={Facebook} variant="sky" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="sky-violet" size="lg" as="h1">Facebook Analytics</GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">Analyze Facebook pages & top performing content</p>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="sky" />

        <Reveal delay={80}>
          <GradientRingCard variant="sky" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
            <BrandSearchBar platform="facebook" onSearch={handleSearch} isLoading={isLoading} />
          </GradientRingCard>
        </Reveal>

        {error && (
          <Reveal delay={120}>
            <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
              <p className="text-sm text-rose-500">{error}</p>
            </GradientRingCard>
          </Reveal>
        )}

        {hasResults && (
          <Reveal delay={160}>
            <div className="space-y-4">
              <ProfileCard profile={profile!} isLoading={isLoading} />
              <FilterToolbar filters={filters} onChange={setFilters} maxEngagement={maxEngagement} />
              <p className="text-sm text-muted-foreground">{filteredPosts.length} of {totalPosts} posts</p>
              <PostsGrid posts={filteredPosts} isLoading={isLoading} onPostClick={handlePostClick} contentPostIds={contentPostIds} />
              {hasMore && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" onClick={loadMore} className="gap-2 border-sky-500/40 hover:bg-sky-500/10">
                    <Loader2 className="w-4 h-4" />Load More
                  </Button>
                </div>
              )}
            </div>
          </Reveal>
        )}

        {!hasResults && !isLoading && !error && (
          <Reveal delay={160}>
            <GradientRingCard variant="sky" hoverLift={false} ringIntensity="subtle">
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="group mb-5"><Icon3D icon={SearchCheck} variant="sky" size="lg" /></div>
                <h3 className="text-lg font-semibold mb-1">Start by searching for a brand</h3>
                <p className="text-sm text-muted-foreground mb-6 max-w-md">Enter any Facebook page username to analyze their top performing content</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLE_BRANDS.map((brand) => (
                    <Button key={brand} variant="outline" size="sm" className="text-xs border-sky-500/40 hover:bg-sky-500/10 transition-transform hover:-translate-y-0.5" onClick={() => handleSearch(brand.replace("@", ""))}>{brand}</Button>
                  ))}
                </div>
              </div>
            </GradientRingCard>
          </Reveal>
        )}

        <PostDetailDrawer post={selectedPost} isOpen={!!selectedPost} onClose={() => setSelectedPost(null)} />
      </div>
    </DashboardLayout>
  );
}
