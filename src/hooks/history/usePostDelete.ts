import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { PostWithResults, invalidatePostQueries, deletePostById, deleteMediaFiles } from "./historyUtils";

/**
 * For each Threads platform_posts row in the given posts, attempt to delete the live Threads post via Meta.
 * Returns a list of human-readable failure messages (empty if all succeeded or no Threads rows present).
 */
async function deleteThreadsForPosts(posts: PostWithResults[]): Promise<string[]> {
  const failures: string[] = [];
  for (const post of posts) {
    const threadsRows = (post.platformResults || []).filter(r => r.platform === "threads");
    for (const row of threadsRows) {
      try {
        const { data, error } = await supabase.functions.invoke("threads-delete-post", {
          body: { platform_post_row_id: row.id },
        });
        if (error) {
          failures.push(`Threads delete failed: ${error.message}`);
          continue;
        }
        if (data && data.ok === false && data.reason !== "not_found") {
          failures.push(`Threads delete failed: ${data.message || data.reason}`);
        }
      } catch (e) {
        failures.push(`Threads delete failed: ${(e as Error).message}`);
      }
    }
  }
  return failures;
}

export function usePostDelete() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [deletePost, setDeletePost] = useState<PostWithResults | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedPosts, setSelectedPosts] = useState<Set<string>>(new Set());
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const handleDeletePost = async () => {
    if (!deletePost) return;
    setIsDeleting(true);
    try {
      // Best-effort delete from Threads first
      const failures = await deleteThreadsForPosts([deletePost]);
      if (failures.length > 0) {
        const proceed = window.confirm(
          `${failures.join("\n")}\n\nDelete locally only? (The post may still exist on Threads.)`
        );
        if (!proceed) {
          setIsDeleting(false);
          setDeletePost(null);
          return;
        }
      }

      await deletePostById(deletePost.id, deletePost.media_file_ids);
      toast({ title: "Post deleted", description: "The post and associated media have been removed." });
      invalidatePostQueries(queryClient);
    } catch (error) {
      console.error("Delete error:", error);
      toast({ title: "Delete failed", description: error instanceof Error ? error.message : "Failed to delete post", variant: "destructive" });
    } finally { setIsDeleting(false); setDeletePost(null); }
  };

  const togglePostSelection = (postId: string) => {
    const newSelection = new Set(selectedPosts);
    if (newSelection.has(postId)) newSelection.delete(postId);
    else newSelection.add(postId);
    setSelectedPosts(newSelection);
  };

  const selectAllPosts = (postIds: string[]) => setSelectedPosts(new Set(postIds));
  const deselectAllPosts = () => setSelectedPosts(new Set());

  const handleBulkDelete = async (posts: PostWithResults[]) => {
    if (selectedPosts.size === 0) return;
    setIsBulkDeleting(true);
    try {
      const postIds = Array.from(selectedPosts);
      const selectedPostObjs = posts.filter(p => selectedPosts.has(p.id));

      // Best-effort delete from Threads first
      const failures = await deleteThreadsForPosts(selectedPostObjs);
      if (failures.length > 0) {
        const proceed = window.confirm(
          `${failures.length} Threads delete(s) failed:\n${failures.slice(0, 3).join("\n")}${failures.length > 3 ? "\n…" : ""}\n\nDelete locally only? (Some posts may still exist on Threads.)`
        );
        if (!proceed) {
          setIsBulkDeleting(false);
          setBulkDeleteDialogOpen(false);
          return;
        }
      }

      const allMediaFileIds: string[] = [];
      for (const post of selectedPostObjs) {
        if (post.media_file_ids?.length) allMediaFileIds.push(...post.media_file_ids);
      }

      const { error: platformError } = await supabase.from("platform_posts").delete().in("post_id", postIds);
      if (platformError) throw platformError;
      const { error: postsError } = await supabase.from("posts").delete().in("id", postIds);
      if (postsError) throw postsError;
      if (allMediaFileIds.length > 0) await deleteMediaFiles(allMediaFileIds);

      toast({ title: "Posts deleted", description: `${selectedPosts.size} posts and associated media have been removed.` });
      setSelectedPosts(new Set());
      invalidatePostQueries(queryClient);
    } catch (error) {
      console.error("Bulk delete error:", error);
      toast({ title: "Delete failed", description: error instanceof Error ? error.message : "Failed to delete posts", variant: "destructive" });
    } finally { setIsBulkDeleting(false); setBulkDeleteDialogOpen(false); }
  };

  /**
   * Per-row "Delete from Threads" action used by PostDetailsDialog.
   * Calls the threads-delete-post edge function and never touches the local row,
   * per the product spec: live Meta delete only — local history record stays.
   */
  const handleDeletePlatformPost = async (platformPostRowId: string, platform: string) => {
    if (platform !== "threads") {
      toast({ platform: "threads", title: "Not supported", description: `Platform delete is only implemented for Threads.`, variant: "destructive" });
      return;
    }
    try {
      const { data, error } = await supabase.functions.invoke("threads-delete-post", {
        body: { platform_post_row_id: platformPostRowId },
      });
      if (error) {
        toast({ platform: "threads", title: "Delete failed", description: error.message, variant: "destructive" });
        return;
      }
      if (data && data.ok === false) {
        toast({ platform: "threads",
          title: "Delete failed",
          description: data.message || data.reason || "Threads rejected the request",
          variant: "destructive",
        });
        return;
      }
      toast({ platform: "threads", title: "Deleted from Threads", description: "The live post was removed from Meta." });
      invalidatePostQueries(queryClient);
    } catch (e) {
      toast({ platform: "threads",
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return {
    deletePost, setDeletePost, isDeleting,
    selectedPosts, bulkDeleteDialogOpen, setBulkDeleteDialogOpen, isBulkDeleting,
    handleDeletePost, handleBulkDelete, handleDeletePlatformPost,
    togglePostSelection, selectAllPosts, deselectAllPosts,
  };
}
