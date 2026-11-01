import { compareBrandMetric } from "@/lib/brandMetrics";
import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { AtSign, Loader2, SearchCheck, Hash, BarChart3 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { BrandSearchBar } from "@/components/brand-intelligence/BrandSearchBar";
import { ProfileCard } from "@/components/brand-intelligence/ProfileCard";
import { FilterToolbar } from "@/components/brand-intelligence/FilterToolbar";
import { PostsGrid } from "@/components/brand-intelligence/PostsGrid";
import { PostDetailDrawer } from "@/components/brand-intelligence/PostDetailDrawer";
import { ThreadsDiscoveryPanel } from "@/components/brand-intelligence/ThreadsDiscoveryPanel";
import { ThreadsKeywordSearchPanel } from "@/components/brand-intelligence/ThreadsKeywordSearchPanel";
import { OwnedAnalyticsScreen } from "@/features/analytics-contract/ui/OwnedAnalyticsScreen";
import { ThreadsPermissionStatus } from "@/components/brand-intelligence/ThreadsPermissionStatus";
import { ThreadsErrorCard, mapThreadsReason } from "@/components/brand-intelligence/ThreadsErrorCard";
import { useThreadsLiveDiscovery } from "@/hooks/useThreadsLiveDiscovery";
import { useOwnedThreadsAccounts } from "@/hooks/useOwnedThreadsAccounts";
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

export default function ThreadsAnalytics() {
  const { t } = useTranslation("analytics");
  const navigate = useNavigate();
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const validTabs = ["analyze", "discovery", "keyword_search", "insights"] as const;
  type ThreadsMode = typeof validTabs[number];
  const initialTab: ThreadsMode = (validTabs as readonly string[]).includes(tabParam || "")
    ? (tabParam as ThreadsMode)
    : "analyze";
  const [threadsMode, setThreadsMode] = useState<ThreadsMode>(initialTab);

  // Keep URL in sync with active tab (deep-linkable: ?tab=discovery, etc.)
  useEffect(() => {
    if (searchParams.get("tab") !== threadsMode) {
      const next = new URLSearchParams(searchParams);
      next.set("tab", threadsMode);
      setSearchParams(next, { replace: true });
    }
  }, [threadsMode]);

  const [filters, setFilters] = useState<BrandScrapeFilters>(DEFAULT_FILTERS);
  const [selectedPost, setSelectedPost] = useState<BrandPost | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);
  const { ownsUsername } = useOwnedThreadsAccounts();
  // Analyze now uses the same live `threads-discovery` flow as the Discovery tab —
  // no more legacy brand-scrape / Apify / "pending Meta approval" path.
  const {
    profile,
    posts,
    totalPosts,
    hasMore,
    isLoading,
    errorState,
    requestSource,
    search: liveSearch,
    removePostId,
  } = useThreadsLiveDiscovery();

  const ownedAccountId = ownsUsername(profile?.username);

  const handleConfirmDelete = async () => {
    const id = pendingDeleteId;
    if (!id || !ownedAccountId) return;
    setIsDeletingId(id);
    try {
      const { data, error } = await supabase.functions.invoke("threads-delete-post", {
        body: { thread_id: id, social_account_id: ownedAccountId },
      });
      if (error) throw new Error(error.message || t("errors.deleteFailed", "Delete failed"));
      if (data && data.ok === false) {
        toast.error(mapThreadsReason(data, "discovery").message || t("errors.couldNotDelete", "Could not delete on Threads"));
        return;
      }
      toast.success(t("toast.postDeleted", "Post deleted from Threads"));
      removePostId(id);
    } catch (err) {
      toast.error((err as Error).message || t("errors.deleteFailed", "Delete failed"));
    } finally {
      setIsDeletingId(null);
      setPendingDeleteId(null);
    }
  };

  const { data: contentPostIds = new Set<string>() } = useQuery({
    queryKey: ["bi-content-post-ids", session?.user?.id],
    queryFn: async () => {
      if (!session?.user?.id) return new Set<string>();
      const { data } = await supabase.from("bi_post_content").select("post_id").eq("user_id", session.user.id);
      return new Set((data || []).map((d: { post_id: string }) => d.post_id));
    },
    enabled: !!session?.user?.id,
  });

  const handleSearch = (username: string) => liveSearch(username);

  const handlePostClick = (post: BrandPost) => {
    if (post.mediaType === "VIDEO" || post.mediaType === "REEL") {
      navigate(`/brand-intelligence/post/${post.id}`, { state: { post, platform: "threads", username: profile?.username } });
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
            <Icon3D icon={AtSign} variant="indigo" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="violet-sky" size="lg" as="h1">{t("header.threads", "Threads Analytics")}</GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">{t("header.threadsSubtitle", "Analyze Threads profiles, discover trends & insights")}</p>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="violet" />

        <Reveal delay={60}>
          <div className="inline-flex flex-wrap gap-1 rounded-xl bg-card border border-border/40 p-1">
            {([
              { key: "analyze", label: t("header.discovery", "Discovery"), Icon: SearchCheck },
              { key: "discovery", label: t("header.analyze", "Analyze"), Icon: AtSign },
              { key: "keyword_search", label: t("header.keywordSearch", "Keyword Search"), Icon: Hash },
              { key: "insights", label: t("header.insights", "Insights"), Icon: BarChart3 },
            ] as const).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setThreadsMode(key as ThreadsMode)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all",
                  threadsMode === key
                    ? "text-white shadow-md bg-neutral-900 dark:bg-neutral-800"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </Reveal>

        {threadsMode === "analyze" && (
          <Reveal delay={120} className="space-y-4">
            <GradientRingCard variant="indigo" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
              <BrandSearchBar platform="threads" scope="analyze" onSearch={handleSearch} isLoading={isLoading} />
            </GradientRingCard>
            {errorState && <ThreadsErrorCard state={errorState} />}
            {hasResults && (
              <div className="space-y-4">
                <ProfileCard profile={profile!} isLoading={isLoading} />
                <FilterToolbar filters={filters} onChange={setFilters} maxEngagement={maxEngagement} />
                <p className="text-sm text-muted-foreground">{t("posts.countOf", "{{filtered}} of {{total}} posts", { filtered: filteredPosts.length, total: totalPosts })}</p>
                <PostsGrid
                  posts={filteredPosts}
                  isLoading={isLoading}
                  onPostClick={handlePostClick}
                  contentPostIds={contentPostIds}
                  canDelete={!!ownedAccountId}
                  deletingPostId={isDeletingId}
                  onPostDelete={(p) => setPendingDeleteId(p.id)}
                />
                {hasMore && (
                  <div className="flex justify-center pt-4">
                    <Button variant="outline" disabled className="gap-2 border-input"><Loader2 className="w-4 h-4" />{t("actions.loadMore", "Load More")}</Button>
                  </div>
                )}
              </div>
            )}
            {!hasResults && !isLoading && !errorState && (
              <GradientRingCard variant="indigo" hoverLift={false} ringIntensity="subtle">
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="group mb-5"><Icon3D icon={SearchCheck} variant="indigo" size="lg" /></div>
                  <h3 className="text-lg font-semibold mb-1">{t("empty.searchBrand", "Start by searching for a brand")}</h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-md">{t("empty.searchHintThreads", "Enter any Threads username to analyze their top performing content")}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {EXAMPLE_BRANDS.map((brand) => (
                      <Button key={brand} variant="outline" size="sm" className="text-xs border-input hover:bg-muted transition-transform hover:-translate-y-0.5" onClick={() => handleSearch(brand.replace("@", ""))}>{brand}</Button>
                    ))}
                  </div>
                </div>
              </GradientRingCard>
            )}
          </Reveal>
        )}

        {/* Keep panels mounted across tab switches so search results, recent searches,
            insights selection, etc. persist. Only the Analyze tab is conditionally
            rendered because its state is lifted via the useThreadsLiveDiscovery hook. */}
        <div className={threadsMode === "discovery" ? "space-y-4" : "hidden"}>
          <ThreadsDiscoveryPanel />
        </div>
        <div className={threadsMode === "keyword_search" ? "space-y-4" : "hidden"}>
          <ThreadsKeywordSearchPanel />
        </div>
        <div className={threadsMode === "insights" ? "space-y-4" : "hidden"}>
          <OwnedAnalyticsScreen platform="threads" />
        </div>

        <PostDetailDrawer
          post={selectedPost}
          isOpen={!!selectedPost}
          onClose={() => setSelectedPost(null)}
          platformUsername={profile?.username}
          onDeleted={(id) => removePostId(id)}
        />

        <AlertDialog open={!!pendingDeleteId} onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}>
          <AlertDialogContent className="bg-card border-border/50">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("dialog.deleteThreadsTitle", "Delete this post from Threads?")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("dialog.deleteThreadsBody", "This removes the post from Meta. Your local history record stays so you can still see it here.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmDelete} disabled={!!isDeletingId}>
                {isDeletingId ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
                {t("common:delete", "Delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
