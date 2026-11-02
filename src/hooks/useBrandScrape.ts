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

export function useBrandScrape(ownerId: string | undefined) {
  const requestOwner = useRef(ownerId);
  const requestGeneration = useRef(0);
  if (requestOwner.current !== ownerId) {
    requestOwner.current = ownerId;
    requestGeneration.current++;
  }
  const [transientOwner, setTransientOwner] = useState(ownerId);
  const sameOwner = transientOwner === ownerId;
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [platform, setPlatform] = useState<BrandPlatform>("instagram");
  const [allPosts, setAllPosts] = useState<BrandPost[]>([]);
  const [searchTriggered, setSearchTriggered] = useState(false);

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

  const { data, isLoading, error } = useQuery({
    queryKey: ["brand-scrape", ownerId, platform, username, 0],
    queryFn: () => callBrandScrape(0),
    enabled: !!ownerId && sameOwner && searchTriggered && !!username && !sessionProfile,
    staleTime: 3600000,
    retry: 1,
  });

  const search = useCallback((newUsername: string, newPlatform: BrandPlatform) => {
    requestGeneration.current++;
    setTransientOwner(ownerId);
    setSessionProfile(null);
    setSessionPosts(null);
    setUsername(newUsername);
    setPlatform(newPlatform);
    setAllPosts([]);
    setSearchTriggered(true);
    queryClient.invalidateQueries({ queryKey: ["brand-scrape", ownerId, newPlatform, newUsername, 0] });
  }, [queryClient, ownerId]);

  const loadMore = useCallback(async () => {
    if (!sameOwner || !username || !data?.hasMore) return;
    const nextOffset = (data.posts?.length || 0) + allPosts.length;
    if (nextOffset >= data.totalPosts) return;
    const generation = requestGeneration.current;

    try {
      const moreData = await callBrandScrape(nextOffset);
      if (moreData.posts && generation === requestGeneration.current) {
        setAllPosts((prev) => [...new Map([...prev, ...moreData.posts].map((post) => [post.id, post])).values()]);
      }
    } catch (err) {
      console.error("Load more error:", err);
    }
  }, [username, data, allPosts, callBrandScrape, sameOwner]);

  const reset = useCallback(() => {
    requestGeneration.current++;
    setUsername("");
    setAllPosts([]);
    setSearchTriggered(false);
    setSessionProfile(null);
    setSessionPosts(null);
  }, []);

  /** Load data from a stored history session without re-scraping */
  const loadFromSession = useCallback((profile: BrandProfile, posts: BrandPost[]) => {
    requestGeneration.current++;
    setTransientOwner(ownerId);
    setSessionProfile(profile);
    setSessionPosts(posts);
    setSearchTriggered(false);
    setAllPosts([]);
    setPlatform(profile.platform);
    setUsername(profile.username);
  }, [ownerId]);

  // Merge: session data takes priority, then query data
  const activeProfile = (sameOwner ? sessionProfile : null) || data?.profile || null;
  const visiblePosts = sameOwner ? allPosts : [];
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

  return {
    profile: activeProfile,
    profileSource,
    posts: combinedPosts,
    totalPosts: sameOwner && sessionPosts ? sessionPosts.length : (data?.totalPosts || 0),
    hasMore: sameOwner && sessionPosts ? false : combinedPosts.length < (data?.totalPosts || 0),
    isLoading: sameOwner && sessionProfile ? false : isLoading,
    error: sameOwner && sessionProfile ? null : (error ? (error as Error).message : null),
    reconnectRequired: ["IG_INSIGHTS_SCOPE_MISSING", "IG_RECONNECT_REQUIRED"].includes(
      data?.warning?.code ?? (error && "code" in error ? String(error.code) : "")),
    warning: data?.warning?.message ?? null,
    search,
    loadMore,
    loadFromSession,
    reset,
    platform,
    setPlatform,
  };
}
