import { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { resolveBrandProfileSource } from "@/types/brand-intelligence";
import type { BrandProfile, BrandPost, BrandPlatform, BrandProfileSource } from "@/types/brand-intelligence";

type BrandScrapeResponse = {
  profile: BrandProfile;
  posts: BrandPost[];
  totalPosts: number;
  hasMore: boolean;
  warning?: { code: string; message: string };
};
const RECONNECT_CODES = ["IG_INSIGHTS_SCOPE_MISSING", "IG_RECONNECT_REQUIRED"];

export function useBrandScrape(ownerId: string | undefined) {
  const requestOwner = useRef(ownerId);
  const requestGeneration = useRef(0);
  const loadMoreToken = useRef<symbol | null>(null);
  if (requestOwner.current !== ownerId) {
    requestOwner.current = ownerId;
    requestGeneration.current++;
    loadMoreToken.current = null;
  }
  const [transientOwner, setTransientOwner] = useState(ownerId);
  const sameOwner = transientOwner === ownerId;
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [platform, setPlatform] = useState<BrandPlatform>("instagram");
  const [allPosts, setAllPosts] = useState<BrandPost[]>([]);
  const [continuation, setContinuation] = useState<{ hasMore: boolean; nextOffset: number; totalPosts: number } | null>(null);
  const [searchTriggered, setSearchTriggered] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<"unavailable" | null>(null);
  const [pageWarning, setPageWarning] = useState<{ code: string; message: string } | null>(null);

  // For loading from history sessions
  const [sessionProfile, setSessionProfile] = useState<BrandProfile | null>(null);
  const [sessionPosts, setSessionPosts] = useState<BrandPost[] | null>(null);

  const callBrandScrape = useCallback(async (requestOffset: number): Promise<BrandScrapeResponse> => {
    const { data: sessionData } = await supabase.auth.getSession();
    let session = sessionData.session;

    if (!session) {
      const { data: refreshedSessionData, error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError || !refreshedSessionData.session) {
        throw new Error("Your session has expired. Please log out and log back in.");
      }
      session = refreshedSessionData.session;
    }
    if (!ownerId || session.user.id !== ownerId) throw new Error("Your session changed. Please search again.");

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/brand-scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({ username, platform, offset: requestOffset }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : `Failed to fetch brand data (${response.status})`;

      if (response.status === 401 || message.includes("Unauthorized")) {
        throw new Error("Your session has expired. Please log out and log back in.");
      }

      throw Object.assign(new Error(message), { code: typeof payload.error_code === "string" ? payload.error_code : null });
    }

    if (typeof payload?.error === "string") {
      throw new Error(payload.error);
    }

    return payload as BrandScrapeResponse;
  }, [platform, username, ownerId]);

  const { data: cachedData, isLoading, error } = useQuery({
    queryKey: ["brand-scrape", ownerId, platform, username, 0],
    queryFn: () => callBrandScrape(0),
    enabled: !!ownerId && sameOwner && searchTriggered && !!username && !sessionProfile,
    staleTime: 3600000,
    retry: 1,
  });
  // React Query retains old data after a failed refetch. It cannot represent
  // the result of a newly refused search, especially after a permission denial.
  const data = error ? undefined : cachedData;
  const hasMore = sameOwner && !!data && !sessionPosts && (continuation?.hasMore ?? data.hasMore);

  const releaseLoadMore = useCallback(() => {
    loadMoreToken.current = null;
    setIsLoadingMore(false);
    setLoadMoreError(null);
    setPageWarning(null);
  }, []);

  const search = useCallback((newUsername: string, newPlatform: BrandPlatform) => {
    requestGeneration.current++;
    releaseLoadMore();
    setTransientOwner(ownerId);
    setSessionProfile(null);
    setSessionPosts(null);
    setUsername(newUsername);
    setPlatform(newPlatform);
    setAllPosts([]);
    setContinuation(null);
    setSearchTriggered(true);
    queryClient.invalidateQueries({ queryKey: ["brand-scrape", ownerId, newPlatform, newUsername, 0] });
  }, [queryClient, ownerId, releaseLoadMore]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !username || !data || loadMoreToken.current) return;
    const nextOffset = continuation?.nextOffset ?? data.posts.length;
    const generation = requestGeneration.current;
    const token = Symbol("load-more");
    const owns = () => loadMoreToken.current === token && generation === requestGeneration.current;
    loadMoreToken.current = token;
    setIsLoadingMore(true); setLoadMoreError(null);

    try {
      const moreData = await callBrandScrape(nextOffset);
      if (!owns()) return;
      if (moreData.posts) {
        setAllPosts((prev) => [...new Map([...prev, ...moreData.posts].map((post) => [post.id, post])).values()]);
        setContinuation({ hasMore: moreData.hasMore, nextOffset: nextOffset + moreData.posts.length, totalPosts: moreData.totalPosts });
      }
      if (moreData.warning) setPageWarning(moreData.warning);
    } catch (err) {
      if (!owns()) return;
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (RECONNECT_CODES.includes(code)) setPageWarning({ code, message: "Reconnect Instagram to enable official competitor data." });
      else setLoadMoreError("unavailable");
    } finally {
      if (loadMoreToken.current === token) { loadMoreToken.current = null; setIsLoadingMore(false); }
    }
  }, [username, data, continuation, callBrandScrape, hasMore]);

  const reset = useCallback(() => {
    requestGeneration.current++;
    releaseLoadMore();
    setUsername("");
    setAllPosts([]);
    setContinuation(null);
    setSearchTriggered(false);
    setSessionProfile(null);
    setSessionPosts(null);
  }, [releaseLoadMore]);

  /** Load data from a stored history session without re-scraping */
  const loadFromSession = useCallback((profile: BrandProfile, posts: BrandPost[]) => {
    requestGeneration.current++;
    releaseLoadMore();
    setTransientOwner(ownerId);
    setSessionProfile(profile);
    setSessionPosts(posts);
    setSearchTriggered(false);
    setAllPosts([]);
    setContinuation(null);
    setPlatform(profile.platform);
    setUsername(profile.username);
  }, [ownerId, releaseLoadMore]);

  // Merge: session data takes priority, then query data
  const activeProfile = (sameOwner ? sessionProfile : null) || data?.profile || null;
  const visiblePosts = sameOwner && data ? allPosts : [];
  const combinedPosts = (sameOwner ? sessionPosts : null) || (data?.posts ? [...data.posts, ...visiblePosts] : visiblePosts);

  /**
   * The source of the profile the owner is looking at.
   *
   * It is the source the PRODUCER stated, and nothing else. The
   * answer is "unknown" until the producer publishes one, and it stays
   * "unknown" for a cached answer - a cache entry does not say where
   * its numbers came from (T8-01).
   */
  const profileSource: BrandProfileSource = resolveBrandProfileSource(activeProfile?.source);
  const showingSession = sameOwner && !!sessionProfile;
  const shownWarning = showingSession ? null : (pageWarning ?? data?.warning ?? null);

  return {
    profile: activeProfile,
    profileSource,
    posts: combinedPosts,
    totalPosts: sameOwner && sessionPosts ? sessionPosts.length : (data ? ((sameOwner ? continuation?.totalPosts : undefined) ?? data.totalPosts) : 0),
    hasMore,
    isLoading: sameOwner && sessionProfile ? false : isLoading,
    isLoadingMore: sameOwner && isLoadingMore,
    error: sameOwner && sessionProfile ? null : (error ? (error as Error).message : null),
    loadMoreError: sameOwner && !showingSession ? loadMoreError : null,
    reconnectRequired: RECONNECT_CODES.includes(
      shownWarning?.code ?? (!showingSession && error && "code" in error ? String(error.code) : "")),
    warning: shownWarning?.message ?? null,
    search,
    loadMore,
    loadFromSession,
    reset,
    platform,
    setPlatform,
  };
}
