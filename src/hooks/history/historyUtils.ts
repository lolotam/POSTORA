import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

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
    .select("id, file_path, storage_bucket, cloudinary_public_id, file_type")
    .in("id", mediaFileIds);

  if (fetchError || !mediaFiles || mediaFiles.length === 0) return;

  const cloudinaryFiles = mediaFiles.filter(f => f.storage_bucket === "cloudinary" && f.cloudinary_public_id);
  const providerOnlyFiles = mediaFiles.filter(f => f.storage_bucket !== "cloudinary" && (f.storage_bucket === "openinary" || f.file_path?.startsWith("http")));
  const supabaseFiles = mediaFiles.filter(f => f.storage_bucket !== "cloudinary" && !providerOnlyFiles.includes(f));

  if (cloudinaryFiles.length > 0) {
    try {
      const imageIds = cloudinaryFiles.filter(f => f.file_type === "image").map(f => f.cloudinary_public_id!);
      const videoIds = cloudinaryFiles.filter(f => f.file_type === "video").map(f => f.cloudinary_public_id!);
      if (imageIds.length > 0) await supabase.functions.invoke("cloudinary-delete", { body: { publicIds: imageIds, resourceType: "image" } });
      if (videoIds.length > 0) await supabase.functions.invoke("cloudinary-delete", { body: { publicIds: videoIds, resourceType: "video" } });
    } catch (err) { console.error("Error deleting from Cloudinary:", err); }
  }

  if (providerOnlyFiles.length > 0) {
    try {
      await supabase.functions.invoke("cloudinary-delete", { body: { mediaFileIds: providerOnlyFiles.map(f => f.id) } });
    } catch (err) { console.error("Error deleting provider-backed media:", err); }
  }

  if (supabaseFiles.length > 0) {
    try {
      await supabase.storage.from("media").remove(supabaseFiles.map(f => f.file_path));
    } catch (err) { console.error("Error deleting from Supabase storage:", err); }
  }

  await supabase.from("media_files").delete().in("id", mediaFileIds);
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
