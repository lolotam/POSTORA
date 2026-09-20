import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { usePostsWithResults, Post, PlatformPost } from "@/hooks/usePosts";
import { usePublishing } from "@/contexts/PublishingContext";
import { Platform } from "@/lib/types";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Loader2, Send, Image } from "lucide-react";
import { Reveal, GradientDivider, GradientRingCard, Icon3D } from "@/components/fx";
import { cn } from "@/lib/utils";
import {
  PostFilters,
  HistoryHeader,
  HistoryTable,
  PostDetailsDialog,
  DeletePostDialog,
  BulkDeleteDialog,
  RetryAccountDialog,
  RetryMediaDialog,
  MediaOperationsHistory,
} from "@/components/history";
import { PublishingStatusIndicator } from "@/components/history/PublishingStatusIndicator";
import { useHistoryActions } from "@/hooks/useHistoryActions";

interface PostWithResults extends Post {
  platformResults: PlatformPost[];
}

interface AccountInfo {
  username: string | null;
  avatarUrl: string | null;
  profileName: string | null;
  tiktokUsername?: string | null; // The actual TikTok handle from account_metadata
}

export default function History() {
  const [search, setSearch] = useState("");
  const [selectedFilter, setSelectedFilter] = useState<"all" | "completed" | "failed" | "pending">("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "api">("all");
  const [platformFilter, setPlatformFilter] = useState<Platform | "all">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [detailsPost, setDetailsPost] = useState<PostWithResults | null>(null);
  const [detailsMedia, setDetailsMedia] = useState<Array<{ id: string; url: string; kind: "image" | "video" }>>([]);
  const [detailsMediaLoading, setDetailsMediaLoading] = useState(false);
  const [accountsCache, setAccountsCache] = useState<Record<string, AccountInfo>>({});

  const { data: posts = [], isLoading, isFetching, refetch, error } = usePostsWithResults();
  const { publishingPosts } = usePublishing();
  const { toast } = useToast();
  const { t } = useTranslation("history");

  const actions = useHistoryActions();

  // Fetch account info for avatars
  const allSocialAccountIds = useMemo(() => {
    const ids = new Set<string>();
    posts.forEach((post) => {
      post.platformResults?.forEach((result) => {
        if (result.social_account_id) {
          ids.add(result.social_account_id);
        }
      });
    });
    return Array.from(ids);
  }, [posts]);

  useEffect(() => {
    const idsToFetch = allSocialAccountIds.filter((id) => !accountsCache[id]);
    if (idsToFetch.length === 0) return;

    (async () => {
      const { data, error } = await supabase
        .from("social_accounts")
        .select(`
          id, 
          platform,
          platform_username, 
          avatar_url,
          account_metadata,
          social_profile_id,
          social_profiles!social_accounts_social_profile_id_fkey (
            name
          )
        `)
        .in("id", idsToFetch);

      if (!error && data) {
        const newCache: Record<string, AccountInfo> = { ...accountsCache };
        data.forEach((acc: any) => {
          // For TikTok, extract the actual username from account_metadata
          let tiktokUsername: string | null = null;
          if (acc.platform === 'tiktok' && acc.account_metadata) {
            tiktokUsername = acc.account_metadata.tiktok_username || 
                            acc.account_metadata.creator_username || 
                            null;
          }
          
          newCache[acc.id] = {
            username: acc.platform_username ?? null,
            avatarUrl: acc.avatar_url ?? null,
            profileName: acc.social_profiles?.name ?? null,
            tiktokUsername,
          };
        });
        setAccountsCache(newCache);
      }
    })();
  }, [allSocialAccountIds]);

  // Load media for details dialog using signed URLs (bucket is private)
  useEffect(() => {
    let cancelled = false;

    async function loadDetailsMedia() {
      if (!detailsPost) {
        setDetailsMedia([]);
        return;
      }

      const mediaIds = (detailsPost.media_file_ids || []).filter((id) => typeof id === "string");
      if (mediaIds.length === 0) {
        setDetailsMedia([]);
        return;
      }

      setDetailsMediaLoading(true);
      const { data: mediaRows, error: mediaErr } = await supabase
        .from("media_files")
        .select("id, file_path, file_type, mime_type, storage_bucket")
        .in("id", mediaIds);

      if (cancelled) return;

      if (mediaErr) {
        setDetailsMedia([]);
        setDetailsMediaLoading(false);
        return;
      }

      // Generate URLs for each media file
      // Cloudinary files have the URL directly in file_path
      // Supabase storage files need signed URLs
      const previews: Array<{ id: string; url: string; kind: "image" | "video" }> = [];
      for (const m of mediaRows || []) {
        if (!m.file_path) continue;
        
        let url: string;
        
        if (m.storage_bucket === "cloudinary") {
          // Cloudinary files: file_path contains the full URL
          url = m.file_path;
        } else if (m.storage_bucket) {
          // Supabase storage: create signed URL
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from(m.storage_bucket)
            .createSignedUrl(m.file_path, 3600); // 1 hour expiry
          
          if (signedUrlError || !signedUrlData?.signedUrl) continue;
          url = signedUrlData.signedUrl;
        } else {
          continue;
        }
        
        const mime = (m.mime_type || "").toLowerCase();
        const kind: "image" | "video" = mime.startsWith("video/") || m.file_type === "video" ? "video" : "image";
        previews.push({ id: m.id, url, kind });
      }

      if (!cancelled) {
        setDetailsMedia(previews);
        setDetailsMediaLoading(false);
      }
    }

    loadDetailsMedia();
    return () => { cancelled = true; };
  }, [detailsPost?.id]);

  // Filtering
  const filteredHistory = posts.filter((post) => {
    const matchesSearch = (post.caption || "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = selectedFilter === "all" || post.status === selectedFilter;
    const postSource = (post as PostWithResults & { source?: string }).source || "manual";
    const matchesSource = sourceFilter === "all" || postSource === sourceFilter;
    const matchesPlatform = platformFilter === "all" || post.platforms.includes(platformFilter);
    return matchesSearch && matchesStatus && matchesSource && matchesPlatform;
  });

  const failedPosts = posts.filter((post) =>
    post.platformResults?.some((r) => r.status === "failed")
  );

  // Pagination
  const totalItems = filteredHistory.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedHistory = filteredHistory.slice(startIndex, endIndex);

  const handleFilterChange = (filterFn: () => void) => {
    filterFn();
    setCurrentPage(1);
  };

  const exportHistory = (exportFormat: "csv" | "json") => {
    const exportData = filteredHistory.map((post) => ({
      id: post.id,
      caption: post.caption || "",
      platforms: post.platforms.join(", "),
      status: post.status,
      source: (post as PostWithResults & { source?: string }).source || "manual",
      created_at: post.created_at,
      posted_at: post.posted_at || "",
      scheduled_at: post.scheduled_at || "",
      platform_results: post.platformResults?.map((r) => ({
        platform: r.platform,
        status: r.status,
        url: r.platform_post_url || "",
        error: r.error_message || "",
      })) || [],
    }));

    let content: string;
    let mimeType: string;
    let filename: string;

    if (exportFormat === "json") {
      content = JSON.stringify(exportData, null, 2);
      mimeType = "application/json";
      filename = `post-history-${format(new Date(), "yyyy-MM-dd")}.json`;
    } else {
      const headers = ["ID", "Caption", "Platforms", "Status", "Source", "Created At", "Posted At", "Scheduled At"];
      const csvRows = [headers.join(",")];

      exportData.forEach((post) => {
        const row = [
          post.id,
          `"${post.caption.replace(/"/g, '""')}"`,
          `"${post.platforms}"`,
          post.status,
          post.source,
          post.created_at,
          post.posted_at,
          post.scheduled_at,
        ];
        csvRows.push(row.join(","));
      });

      content = csvRows.join("\n");
      mimeType = "text/csv";
      filename = `post-history-${format(new Date(), "yyyy-MM-dd")}.csv`;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: t("toast.exportComplete", "Export complete"),
      description: t("toast.exportDesc", "History exported as {{format}}.", {
        format: exportFormat.toUpperCase(),
      }),
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-10">
        {/* Live Publishing Status */}
        <PublishingStatusIndicator publishingPosts={publishingPosts} />

        <Tabs defaultValue="posts" className="w-full">
          <Reveal>
            <TabsList className="flex flex-nowrap h-auto gap-2 bg-transparent p-0 mb-2 overflow-x-auto scrollbar-hide">
              <TabsTrigger
                value="posts"
                className={cn(
                  "group relative gap-2 rounded-xl border border-border/60 bg-card/60 backdrop-blur-md px-4 py-2 transition-all duration-300 hover:-translate-y-0.5 hover:bg-card",
                  "data-[state=active]:bg-gradient-to-br data-[state=active]:text-white data-[state=active]:border-transparent data-[state=active]:shadow-lg data-[state=active]:ring-1 data-[state=active]:ring-white/20",
                  "data-[state=active]:from-emerald-400 data-[state=active]:via-teal-400 data-[state=active]:to-cyan-500 data-[state=active]:shadow-emerald-500/40",
                )}
              >
                <Send className="w-4 h-4" />
                {t("tabs.postHistory", "Post History")}
              </TabsTrigger>
              <TabsTrigger
                value="media"
                className={cn(
                  "group relative gap-2 rounded-xl border border-border/60 bg-card/60 backdrop-blur-md px-4 py-2 transition-all duration-300 hover:-translate-y-0.5 hover:bg-card",
                  "data-[state=active]:bg-gradient-to-br data-[state=active]:text-white data-[state=active]:border-transparent data-[state=active]:shadow-lg data-[state=active]:ring-1 data-[state=active]:ring-white/20",
                  "data-[state=active]:from-violet-500 data-[state=active]:via-fuchsia-500 data-[state=active]:to-pink-500 data-[state=active]:shadow-violet-500/40",
                )}
              >
                <Image className="w-4 h-4" />
                {t("tabs.mediaOperations", "Media Operations")}
              </TabsTrigger>
            </TabsList>
          </Reveal>

          <GradientDivider tone="emerald" className="mb-6" />

          <TabsContent value="posts" className="space-y-8">
            <Reveal>
              <HistoryHeader
              paginatedCount={paginatedHistory.length}
              selectedCount={actions.selectedPosts.size}
              failedCount={failedPosts.length}
              isAllSelected={actions.selectedPosts.size === paginatedHistory.length && paginatedHistory.length > 0}
              bulkRetrying={actions.bulkRetrying}
              bulkRetryProgress={actions.bulkRetryProgress}
              onSelectAll={() => actions.selectAllPosts(paginatedHistory.map((p) => p.id))}
              onDeselectAll={actions.deselectAllPosts}
              onBulkDelete={() => actions.setBulkDeleteDialogOpen(true)}
              onBulkRetry={() => actions.handleBulkRetry(failedPosts as PostWithResults[])}
              onExport={exportHistory}
              onRefresh={() => refetch()}
              isRefreshing={isFetching && !isLoading}
              />
            </Reveal>

            <Reveal delay={80}>
              <PostFilters
              search={search}
              onSearchChange={setSearch}
              selectedFilter={selectedFilter}
              onFilterChange={(f) => handleFilterChange(() => setSelectedFilter(f))}
              sourceFilter={sourceFilter}
              onSourceFilterChange={(f) => handleFilterChange(() => setSourceFilter(f))}
              platformFilter={platformFilter}
              onPlatformFilterChange={(p) => handleFilterChange(() => setPlatformFilter(p))}
              itemsPerPage={itemsPerPage}
              onItemsPerPageChange={(count) => {
                setItemsPerPage(count);
                setCurrentPage(1);
              }}
              />
            </Reveal>

            <div className="space-y-4">
              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <Reveal delay={120}>
                  <GradientRingCard variant="sky">
                    <div className="flex flex-col items-center text-center py-8">
                      <Icon3D icon={Search} variant="sky" size="lg" />
                      <h3 className="mt-5 text-lg font-semibold">{t("empty.failedToLoad", "Failed to load posts")}</h3>
                      <p className="text-muted-foreground mt-1 max-w-sm">
                        {(error as Error)?.message || t("empty.failedToLoadDesc", "Something went wrong while fetching your post history.")}
                      </p>
                    </div>
                  </GradientRingCard>
                </Reveal>
              ) : filteredHistory.length === 0 ? (
                <Reveal delay={120}>
                  <GradientRingCard variant="sky">
                    <div className="flex flex-col items-center text-center py-8">
                      <Icon3D icon={Search} variant="sky" size="lg" />
                      <h3 className="mt-5 text-lg font-semibold">{t("empty.noPosts", "No posts found")}</h3>
                      <p className="text-muted-foreground mt-1 max-w-sm">
                        {search ? t("empty.noSearchMatch", "Try a different search term.") : t("empty.noPostsDesc", "Your post history will appear here once you start publishing.")}
                      </p>
                    </div>
                  </GradientRingCard>
                </Reveal>
              ) : (
                <>
                  <div className="inline-flex items-center gap-2 text-xs text-muted-foreground rounded-full border border-border/60 bg-card/60 backdrop-blur-md px-3 py-1">
                    {t("pagination.showing", "Showing {{start}}-{{end}} of {{total}} posts", {
                      start: startIndex + 1,
                      end: Math.min(endIndex, totalItems),
                      total: totalItems,
                    })}
                  </div>

                  <Reveal delay={120}>
                    <GradientRingCard variant="emerald" padded={false} innerClassName="overflow-hidden">
                      <HistoryTable
                        posts={paginatedHistory as PostWithResults[]}
                    selectedPosts={actions.selectedPosts}
                    retryingPostId={actions.retryingPostId}
                    accountsCache={accountsCache}
                    isRefetching={isFetching && !isLoading}
                    onToggleSelection={actions.togglePostSelection}
                    onSelectAll={() => actions.selectAllPosts(paginatedHistory.map((p) => p.id))}
                    onDeselectAll={actions.deselectAllPosts}
                    onViewDetails={async (p) => {
                      const post = p as PostWithResults;
                      // Refetch platform_posts to ensure fresh data
                      try {
                        const { data: freshPlatformPosts } = await supabase
                          .from("platform_posts")
                          .select("*")
                          .eq("post_id", post.id);
                        setDetailsPost({
                          ...post,
                          platformResults: (freshPlatformPosts || []) as PlatformPost[],
                        });
                      } catch {
                        setDetailsPost(post);
                      }
                    }}
                    onRetryFailed={(p) => actions.handleRetryFailed(p as PostWithResults)}
                    onRetryWithMedia={(p) => actions.openRetryMediaDialog(p as PostWithResults)}
                    onDelete={(p) => actions.setDeletePost(p as PostWithResults)}
                    isTikTokMediaError={(p) => actions.isTikTokMediaError(p as PostWithResults)}
                      />
                    </GradientRingCard>
                  </Reveal>

                  {totalPages > 1 && (
                    <Pagination className="mt-6">
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                          />
                        </PaginationItem>

                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter((page) => {
                            if (page === 1 || page === totalPages) return true;
                            if (Math.abs(page - currentPage) <= 1) return true;
                            return false;
                          })
                          .map((page, index, array) => {
                            const prevPage = array[index - 1];
                            const showEllipsis = prevPage && page - prevPage > 1;

                            return (
                              <span key={page} className="flex items-center">
                                {showEllipsis && (
                                  <PaginationItem>
                                    <span className="px-3 text-muted-foreground">...</span>
                                  </PaginationItem>
                                )}
                                <PaginationItem>
                                  <PaginationLink
                                    onClick={() => setCurrentPage(page)}
                                    isActive={currentPage === page}
                                    className="cursor-pointer"
                                  >
                                    {page}
                                  </PaginationLink>
                                </PaginationItem>
                              </span>
                            );
                          })}

                        <PaginationItem>
                          <PaginationNext
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  )}
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="media">
            <Reveal>
              <MediaOperationsHistory />
            </Reveal>
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}
      <PostDetailsDialog
        post={detailsPost as any}
        onClose={() => setDetailsPost(null)}
        media={detailsMedia}
        mediaLoading={detailsMediaLoading}
        accountsCache={accountsCache}
        onRetrySinglePlatform={actions.handleRetrySinglePlatform}
        retryingPostId={actions.retryingPostId}
        onDeletePlatformPost={actions.handleDeletePlatformPost}
      />

      <DeletePostDialog
        open={!!actions.deletePost}
        onClose={() => actions.setDeletePost(null)}
        onConfirm={actions.handleDeletePost}
        isDeleting={actions.isDeleting}
      />

      <BulkDeleteDialog
        open={actions.bulkDeleteDialogOpen}
        onClose={() => actions.setBulkDeleteDialogOpen(false)}
        onConfirm={() => actions.handleBulkDelete(posts as any)}
        isDeleting={actions.isBulkDeleting}
        count={actions.selectedPosts.size}
      />

      <RetryAccountDialog
        post={actions.retryDialogPost as any}
        onClose={() => actions.setRetryDialogPost(null)}
        selectedAccountIds={actions.retrySelectedAccountIds}
        onToggleAccount={actions.toggleRetryAccountSelection}
        onRetry={actions.handleRetryWithAccounts}
        isLoading={actions.retryLoading}
        accountsCache={accountsCache}
      />

      <RetryMediaDialog
        post={actions.retryMediaDialogPost as any}
        onClose={() => actions.setRetryMediaDialogPost(null)}
        mediaFiles={actions.retryMediaFiles}
        onMediaChange={actions.setRetryMediaFiles}
        onRetry={actions.handleRetryWithNewMedia}
        isUploading={actions.retryMediaUploading}
      />
    </DashboardLayout>
  );
}
