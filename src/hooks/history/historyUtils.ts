import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { deleteLibraryFiles } from "@/lib/mediaDelete";

export interface PlatformResult {
  id: string;
  platform: string;
  status: string | null;
  social_account_id?: string | null;
  error_message?: string | null;
}

export interface PostWithResults {
  id: string;
  media_file_ids?: string[] | null;
  metadata?: Record<string, unknown>;
  platformResults?: PlatformResult[];
}

export const invalidatePostQueries = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ["posts_with_results"] });
  queryClient.invalidateQueries({ queryKey: ["posts"] });
  queryClient.invalidateQueries({ queryKey: ["post_stats"] });
  queryClient.invalidateQueries({ queryKey: ["media-files"] });
};

export const deleteMediaFiles = async (mediaFileIds: string[]) => {
  if (!mediaFileIds || mediaFileIds.length === 0) return;

  const { data: mediaFiles, error: fetchError } = await supabase
    .from("media_files")
    .select("id, file_path, storage_bucket")
    .in("id", mediaFileIds);

  if (fetchError) throw fetchError;
  if (!mediaFiles || mediaFiles.length === 0) return;

  const outcome = await deleteLibraryFiles(mediaFiles, {
    removeStorage: async (paths) => {
      const { error } = await supabase.storage.from("media").remove(paths);
      return error;
    },
    invokeDelete: async (ids) => {
      const { data, error } = await supabase.functions.invoke("cloudinary-delete", { body: { mediaFileIds: ids } });
      return { data, error };
    },
    deleteRows: async (ids) => {
      const { error } = await supabase.from("media_files").delete().in("id", ids);
      if (error) throw error;
    },
  });
  if (outcome.failedIds.length > 0) throw new Error("Some media files could not be deleted");
};

export const deletePostById = async (postId: string, mediaFileIds?: string[] | null) => {
  await supabase.from("platform_posts").delete().eq("post_id", postId);
  const { error } = await supabase.from("posts").delete().eq("id", postId);
  if (error) throw error;
  if (mediaFileIds && mediaFileIds.length > 0) await deleteMediaFiles(mediaFileIds);
};

export const deleteFailedPlatformPosts = async (postId: string) => {
  const { error } = await supabase.from("platform_posts").delete().eq("post_id", postId).eq("status", "failed");
  if (error) throw error;
};

/**
 * Deletes the post's failed rows that name an account and returns them: a retry targets exactly
 * what it removed, not the page's earlier snapshot. A failed row with no account cannot be
 * targeted, so it is kept on record.
 */
export const takeFailedRetryRows = async (postId: string) => {
  const { data, error } = await supabase
    .from("platform_posts")
    .delete()
    .eq("post_id", postId)
    .eq("status", "failed")
    .not("social_account_id", "is", null)
    .select("platform, status, social_account_id");
  if (error) throw error;
  return data ?? [];
};

export const deletePlatformPost = async (platformPostId: string) => {
  const { error } = await supabase.from("platform_posts").delete().eq("id", platformPostId);
  if (error) throw error;
};

export const invokeProcessPost = async (postId: string, specificPlatforms?: string[], specificAccountIds?: string[]) => {
  const body: Record<string, unknown> = { post_id: postId };
  if (specificPlatforms?.length) body.platforms = specificPlatforms;
  if (specificAccountIds?.length) body.account_ids = specificAccountIds;
  const { error } = await supabase.functions.invoke("process-post", { body });
  if (error) throw error;
};
