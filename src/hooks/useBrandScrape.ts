import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { resolveBrandProfileSource } from "@/types/brand-intelligence";
import type { BrandProfile, BrandPost, BrandPlatform, BrandProfileSource } from "@/types/brand-intelligence";

type BrandScrapeResponse = {
  profile: BrandProfile;
  posts: BrandPost[];
  totalPosts: number;
  hasMore: boolean;
};

export function useBrandScrape() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [platform, setPlatform] = useState<BrandPlatform>("instagram");
  const [offset, setOffset] = useState(0);
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

      throw new Error(message);
    }

    if (typeof payload?.error === "string") {
      throw new Error(payload.error);
    }

    return payload as BrandScrapeResponse;
  }, [platform, username]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["brand-scrape", platform, username, 0],
    queryFn: () => callBrandScrape(0),
    enabled: searchTriggered && !!username && !sessionProfile,
    staleTime: 3600000,
    retry: 1,
  });

  const search = useCallback((newUsername: string, newPlatform: BrandPlatform) => {
    setSessionProfile(null);
    setSessionPosts(null);
    setUsername(newUsername);
    setPlatform(newPlatform);
    setOffset(0);
    setAllPosts([]);
    setSearchTriggered(true);
    queryClient.invalidateQueries({ queryKey: ["brand-scrape", newPlatform, newUsername, 0] });
  }, [queryClient]);

  const loadMore = useCallback(async () => {
    if (!username || !data?.hasMore) return;
    const nextOffset = allPosts.length > 0 ? allPosts.length : (data?.posts?.length || 0);

    try {
      const moreData = await callBrandScrape(nextOffset);
      if (moreData.posts) {
        setAllPosts((prev) => [...prev, ...moreData.posts]);
      }
    } catch (err) {
      console.error("Load more error:", err);
    }
  }, [username, data, allPosts, callBrandScrape]);

  const reset = useCallback(() => {
    setUsername("");
    setOffset(0);
    setAllPosts([]);
    setSearchTriggered(false);
    setSessionProfile(null);
    setSessionPosts(null);
  }, []);

  /** Load data from a stored history session without re-scraping */
  const loadFromSession = useCallback((profile: BrandProfile, posts: BrandPost[]) => {
    setSessionProfile(profile);
    setSessionPosts(posts);
    setSearchTriggered(false);
    setAllPosts([]);
    setPlatform(profile.platform);
    setUsername(profile.username);
  }, []);

  // Merge: session data takes priority, then query data
  const activeProfile = sessionProfile || data?.profile || null;
  const combinedPosts = sessionPosts || (data?.posts ? [...data.posts, ...allPosts] : allPosts);

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
    totalPosts: sessionPosts ? sessionPosts.length : (data?.totalPosts || 0),
    hasMore: sessionPosts ? false : (data?.hasMore || false),
    isLoading: sessionProfile ? false : isLoading,
    error: sessionProfile ? null : (error ? (error as Error).message : null),
    search,
    loadMore,
    loadFromSession,
    reset,
    platform,
    setPlatform,
  };
}
