import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { Platform } from "@/lib/types";

export interface PostMetadata {
  selected_account_ids?: string[];
  schedule_timezone?: string;
  [key: string]: unknown;
}

export interface Post {
  id: string;
  user_id: string;
  caption: string | null;
  platforms: Platform[];
  media_file_ids: string[] | null;
  status: "pending" | "processing" | "completed" | "failed" | "scheduled";
  scheduled_at: string | null;
  posted_at: string | null;
  created_at: string;
  source?: string;
  metadata?: PostMetadata | null;
}

export interface PlatformPost {
  id: string;
  post_id: string;
  platform: Platform;
  social_account_id?: string | null;
  platform_post_id: string | null;
  platform_post_url: string | null;
  status: "pending" | "success" | "failed" | "pending_inbox";
  error_message: string | null;
  posted_at: string | null;
  response_data?: {
    warnings?: string[];
    [key: string]: unknown;
  } | null;
}

export function usePosts(limit?: number) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["posts", user?.id, limit],
    queryFn: async () => {
      if (!user) return [];

      let query = supabase
        .from("posts")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (limit) {
        query = query.limit(limit);
      }

      const { data, error } = await query;

      if (error) throw error;
      return (data || []) as Post[];
    },
    enabled: !!user,
    retry: false,
  });
}

export function usePostsWithResults(limit?: number) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["posts_with_results", user?.id, limit],
    queryFn: async () => {
      if (!user) return [];

      let postsQuery = supabase
        .from("posts")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (limit) {
        postsQuery = postsQuery.limit(limit);
      }

      const { data: posts, error: postsError } = await postsQuery;

      if (postsError) throw postsError;
      if (!posts || posts.length === 0) return [];

      const postIds = posts.map((p) => p.id);

      // Batch the platform_posts lookup to avoid HTTP 414 "URI Too Long" errors
      // when a user has many posts. Each UUID is ~36 chars + URL-encoding overhead,
      // and Kong/PostgREST reject URLs exceeding ~8KB. Chunk size of 50 keeps us
      // well under that limit (50 * ~40 chars = ~2KB per request).
      const CHUNK_SIZE = 50;
      const allPlatformPosts: PlatformPost[] = [];
      for (let i = 0; i < postIds.length; i += CHUNK_SIZE) {
        const chunk = postIds.slice(i, i + CHUNK_SIZE);
        const { data: chunkData, error: chunkError } = await supabase
          .from("platform_posts")
          .select("*")
          .in("post_id", chunk);
        if (chunkError) throw chunkError;
        if (chunkData) allPlatformPosts.push(...(chunkData as PlatformPost[]));
      }

      return posts.map((post) => ({
        ...post,
        platformResults: allPlatformPosts.filter((pp) => pp.post_id === post.id),
      }));
    },
    enabled: !!user,
    retry: false,
  });
}

export function usePostStats() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["post_stats", user?.id],
    queryFn: async () => {
      if (!user) return { total: 0, completed: 0, failed: 0, scheduled: 0, successRate: 0 };

      const { data, error } = await supabase
        .from("posts")
        .select("status, scheduled_at")
        .eq("user_id", user.id);

      if (error) throw error;

      const posts = data || [];
      const total = posts.length;
      const completed = posts.filter((p) => p.status === "completed").length;
      const failed = posts.filter((p) => p.status === "failed").length;
      const scheduled = posts.filter((p) => p.scheduled_at && new Date(p.scheduled_at) > new Date()).length;
      const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

      return { total, completed, failed, scheduled, successRate };
    },
    enabled: !!user,
  });
}
