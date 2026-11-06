import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "./use-toast";

export interface RealtimeUpdate {
  postId: string;
  platform: string;
  status: "pending" | "success" | "failed" | "pending_inbox";
  timestamp: number;
}

export interface PublishingPost {
  postId: string;
  platforms: string[];
  startedAt: number;
  stillPublishing: boolean;
  completedPlatforms: Map<string, "success" | "failed" | "pending_inbox">;
}

/** The platform_posts columns a realtime change event is read for. */
interface PlatformPostChange {
  id?: string;
  post_id?: string;
  platform?: string;
  status?: RealtimeUpdate["status"];
  platform_post_url?: string | null;
  error_message?: string | null;
}

export function useRealtimePostUpdates() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [publishingPosts, setPublishingPosts] = useState<Map<string, PublishingPost>>(new Map());
  const [recentUpdates, setRecentUpdates] = useState<RealtimeUpdate[]>([]);
  const toastedRows = useRef(new Set<string>());

  // Track a new post that's being published
  const trackPublishingPost = useCallback((postId: string, platforms: string[]) => {
    setPublishingPosts((prev) => {
      const newMap = new Map(prev);
      newMap.set(postId, {
        postId,
        platforms,
        startedAt: Date.now(),
        stillPublishing: false,
        completedPlatforms: new Map(),
      });
      return newMap;
    });
  }, []);

  useEffect(() => {
    if (publishingPosts.size === 0) return;
    const nextDeadline = Math.min(...Array.from(publishingPosts.values(), (post) =>
      post.startedAt + (post.stillPublishing ? 35 * 60_000 : 60_000)));
    const timer = setTimeout(() => {
      setPublishingPosts((previous) => {
        const updated = new Map(previous);
        for (const [postId, post] of updated) {
          const elapsed = Date.now() - post.startedAt;
          if (elapsed >= 35 * 60_000) updated.delete(postId);
          else if (elapsed >= 60_000) updated.set(postId, { ...post, stillPublishing: true });
        }
        return updated;
      });
    }, Math.max(0, nextDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [publishingPosts]);

  // Clear a completed post from tracking
  const clearPublishingPost = useCallback((postId: string) => {
    setPublishingPosts((prev) => {
      const newMap = new Map(prev);
      newMap.delete(postId);
      return newMap;
    });
  }, []);

  useEffect(() => {
    toastedRows.current.clear();
    if (!user?.id) return;

    console.log("[Realtime] Setting up realtime subscriptions for user:", user.id);

    // Subscribe to platform_posts changes
    const platformPostsChannel = supabase
      .channel("platform-posts-changes")
      .on(
        "postgres_changes",
        {
          event: "*", // Listen to INSERT, UPDATE, DELETE
          schema: "public",
          table: "platform_posts",
        },
        async (payload) => {
          console.log("[Realtime] platform_posts change:", payload);

          const newRecord = payload.new as PlatformPostChange;
          const oldRecord = payload.old as PlatformPostChange;

          if (!newRecord?.post_id) return;

          // Check if this post belongs to the current user
          const { data: post } = await supabase
            .from("posts")
            .select("user_id, platforms")
            .eq("id", newRecord.post_id)
            .single();

          if (post?.user_id !== user.id) return;

          // Track the update
          const update: RealtimeUpdate = {
            postId: newRecord.post_id,
            platform: newRecord.platform,
            status: newRecord.status,
            timestamp: Date.now(),
          };

          setRecentUpdates((prev) => [update, ...prev.slice(0, 19)]); // Keep last 20

          // Update publishing progress
          setPublishingPosts((prev) => {
            const publishingPost = prev.get(newRecord.post_id);
            if (publishingPost && newRecord.status !== "pending") {
              const newMap = new Map(prev);
              const updatedPost = { ...publishingPost, completedPlatforms: new Map(publishingPost.completedPlatforms) };
              updatedPost.completedPlatforms.set(newRecord.platform, newRecord.status);

              newMap.set(newRecord.post_id, updatedPost);
              return newMap;
            }
            return prev;
          });

          // Invalidate and force refetch queries to refresh data immediately
          queryClient.refetchQueries({ queryKey: ["posts_with_results"] });
          queryClient.refetchQueries({ queryKey: ["posts"] });
          queryClient.refetchQueries({ queryKey: ["scheduled_posts"] });

          // Delayed secondary refetch to catch parent posts table update (race condition fix)
          if (newRecord.status === "success" || newRecord.status === "failed" || newRecord.status === "pending_inbox") {
            setTimeout(() => {
              queryClient.refetchQueries({ queryKey: ["posts_with_results"] });
              queryClient.refetchQueries({ queryKey: ["posts"] });
              queryClient.refetchQueries({ queryKey: ["post_stats"] });
              queryClient.refetchQueries({ queryKey: ["scheduled_posts"] });
            }, 3000);
          }

          // INSERT can already be terminal. Replayed events for the same row must not toast twice.
          const terminal = newRecord.status === "success" || newRecord.status === "failed";
          const statusChanged = payload.eventType === "INSERT" ||
            (payload.eventType === "UPDATE" && oldRecord?.status !== newRecord.status);
          const shouldToast = terminal
            ? statusChanged && newRecord.id && !toastedRows.current.has(newRecord.id)
            : payload.eventType === "UPDATE" && oldRecord?.status !== newRecord.status;
          if (shouldToast) {
            if (terminal) toastedRows.current.add(newRecord.id);
            if (newRecord.status === "success") {
              toastRef.current({
                title: `Published to ${newRecord.platform}`,
                description: newRecord.platform_post_url ? (
                  <a
                    href={newRecord.platform_post_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:no-underline"
                  >
                    View post →
                  </a>
                ) : (
                  "Post published successfully"
                ),
                duration: 5000,
              });
            } else if (newRecord.status === "failed") {
              toastRef.current({
                title: `Failed on ${newRecord.platform}`,
                description: newRecord.error_message || "Publishing failed",
                variant: "destructive",
                duration: 8000,
              });
            } else if (newRecord.status === "pending_inbox") {
              toastRef.current({
                title: "Check your TikTok inbox",
                description: "TikTok posts are sent to your inbox. Open the TikTok app to complete posting.",
                duration: 8000,
              });
              // Force immediate refetch after short delay to ensure DB is updated
              setTimeout(() => {
                queryClient.refetchQueries({ queryKey: ["posts_with_results"] });
                queryClient.refetchQueries({ queryKey: ["posts"] });
              }, 500);
            }
          }
        }
      )
      .subscribe((status) => {
        console.log("[Realtime] platform_posts subscription status:", status);
      });

    // Subscribe to posts changes (for overall status)
    const postsChannel = supabase
      .channel("posts-changes")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "posts",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          console.log("[Realtime] posts change:", payload);

          const newRecord = payload.new as { id?: string; status?: string };

          // Invalidate and force refetch queries
          queryClient.refetchQueries({ queryKey: ["posts_with_results"] });
          queryClient.refetchQueries({ queryKey: ["posts"] });
          queryClient.refetchQueries({ queryKey: ["post_stats"] });
          queryClient.refetchQueries({ queryKey: ["scheduled_posts"] });

          // Clear tracking when post is completed or failed (regardless of previous state)
          if (newRecord.status === "completed" || newRecord.status === "failed") {
            clearPublishingPost(newRecord.id);
          }
        }
      )
      .subscribe((status) => {
        console.log("[Realtime] posts subscription status:", status);
      });

    return () => {
      console.log("[Realtime] Cleaning up subscriptions");
      supabase.removeChannel(platformPostsChannel);
      supabase.removeChannel(postsChannel);
    };
  }, [user?.id, queryClient, clearPublishingPost]);

  return {
    publishingPosts,
    recentUpdates,
    trackPublishingPost,
    clearPublishingPost,
    isPublishing: publishingPosts.size > 0,
  };
}
