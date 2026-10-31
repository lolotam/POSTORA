import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  mapThreadsReason,
  type ThreadsErrorState,
} from "@/components/brand-intelligence/ThreadsErrorCard";
import type { BrandPost, BrandProfile } from "@/types/brand-intelligence";

/** One post as the `threads-discovery` edge function returns it. */
interface ThreadsDiscoveryPost {
  id: string;
  mediaType?: string;
  thumbnailUrl?: string;
  mediaUrl?: string;
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  sharesCount?: number;
  savesCount?: number;
  engagementScore?: number;
  timestamp?: string;
  permalink?: string;
}

/** The `threads-discovery` response fields this hook reads. */
type ThreadsDiscoveryBody = Parameters<typeof mapThreadsReason>[0] & {
  ok?: boolean;
  error?: string;
  profile?: {
    username?: string;
    fullName?: string;
    bio?: string;
    profilePicUrl?: string;
    followersCount?: number;
    followingCount?: number;
    postsCount?: number;
    isVerified?: boolean;
  };
  posts?: ThreadsDiscoveryPost[];
};

/**
 * Live Threads discovery hook used by the Analyze tab.
 *
 * It calls the same `threads-discovery` edge function used by the dedicated
 * Discovery panel, so Analyze and Discovery share one source of truth and
 * one structured error/diagnostic surface. No legacy brand-scrape, no Apify
 * fallback, no hardcoded "pending Meta approval" gating.
 */
export function useThreadsLiveDiscovery() {
  const [profile, setProfile] = useState<BrandProfile | null>(null);
  const [posts, setPosts] = useState<BrandPost[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorState, setErrorState] = useState<ThreadsErrorState | null>(null);
  const [requestSource, setRequestSource] = useState<string | null>(null);

  const reset = useCallback(() => {
    setProfile(null);
    setPosts([]);
    setErrorState(null);
    setRequestSource(null);
  }, []);

  const removePostId = useCallback((id: string) => {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const search = useCallback(async (rawUsername: string) => {
    const clean = rawUsername.replace("@", "").trim().toLowerCase();
    if (!clean) return;

    setIsLoading(true);
    setErrorState(null);
    setProfile(null);
    setPosts([]);
    setRequestSource("threads-discovery");

    // Explicit visibility: surface which edge function Analyze is hitting.
    // Visible in browser console + Lovable preview console logs.
    console.info("[ThreadsAnalyze] invoking edge function", {
      function: "threads-discovery",
      username: clean,
    });

    try {
      const { data, error: fnError } = await supabase.functions.invoke(
        "threads-discovery",
        { body: { username: clean } },
      );

      let body: ThreadsDiscoveryBody | null = data;
      if (fnError && !data) {
        try {
          if (fnError.context && typeof fnError.context.json === "function") {
            body = await fnError.context.json();
          }
        } catch {
          /* ignore */
        }
        if (!body) {
          setErrorState({
            reason: "unknown",
            message: fnError.message || "Unknown error",
          });
          return;
        }
      }

      if (body && body.ok === false) {
        setErrorState(mapThreadsReason(body, "discovery"));
        return;
      }

      if (body?.error && body.ok !== true) {
        setErrorState({ reason: "unknown", message: body.error });
        return;
      }

      // Map discovery payload → BrandProfile / BrandPost shape used by Analyze UI.
      const rawProfile = body?.profile;
      const rawPosts: ThreadsDiscoveryPost[] = body?.posts || [];

      if (rawProfile) {
        setProfile({
          id: rawProfile.username || clean,
          username: rawProfile.username || clean,
          fullName: rawProfile.fullName || rawProfile.username || clean,
          bio: rawProfile.bio || "",
          avatarUrl: rawProfile.profilePicUrl || "",
          followersCount: rawProfile.followersCount || 0,
          followingCount: rawProfile.followingCount || 0,
          postsCount: rawProfile.postsCount ?? rawPosts.length,
          isVerified: !!rawProfile.isVerified,
          platform: "threads",
        });
      }

      setPosts(
        rawPosts.map((p) => ({
          id: p.id,
          mediaType: (p.mediaType || "TEXT") as BrandPost["mediaType"],
          thumbnailUrl: p.thumbnailUrl || p.mediaUrl || "",
          mediaUrl: p.mediaUrl || "",
          caption: p.caption || "",
          likesCount: p.likesCount || 0,
          commentsCount: p.commentsCount || 0,
          videoViewCount: p.videoViewCount || 0,
          sharesCount: p.sharesCount || 0,
          savesCount: p.savesCount || 0,
          engagementScore: p.engagementScore || 0,
          timestamp: p.timestamp || new Date().toISOString(),
          permalink: p.permalink || "",
        })),
      );
    } catch (err) {
      setErrorState({
        reason: "unknown",
        message: (err as Error).message || "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    profile,
    posts,
    totalPosts: posts.length,
    hasMore: false, // discovery endpoint returns the full eligible window
    isLoading,
    errorState,
    requestSource,
    search,
    reset,
    removePostId,
  };
}
