import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildPostoraFileName } from "@/lib/postoraFileName";
import { isMediaQuotaMessage, mediaQuotaHumanMessage } from "@/components/media/uploadErrors";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  PostWithResults, invalidatePostQueries,
  deleteFailedPlatformPosts, deletePlatformPost, invokeProcessPost, takeFailedRetryRows,
} from "./historyUtils";
import { failedRetryTargets } from "./retryTargets";

export function usePostRetry() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [retryingPostId, setRetryingPostId] = useState<string | null>(null);
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [bulkRetryProgress, setBulkRetryProgress] = useState({ current: 0, total: 0 });

  // Retry dialog
  const [retryDialogPost, setRetryDialogPost] = useState<PostWithResults | null>(null);
  const [retrySelectedAccountIds, setRetrySelectedAccountIds] = useState<string[]>([]);
  const [retryLoading, setRetryLoading] = useState(false);

  // Retry with media
  const [retryMediaDialogPost, setRetryMediaDialogPost] = useState<PostWithResults | null>(null);
  const [retryMediaFiles, setRetryMediaFiles] = useState<File[]>([]);
  const [retryMediaUploading, setRetryMediaUploading] = useState(false);
  const retryMediaInputRef = useRef<HTMLInputElement>(null);

  const hasTikTokFailure = (post: PostWithResults) =>
    post.platformResults?.some((r) => r.status === "failed" && r.platform === "tiktok");

  const isTikTokMediaError = (post: PostWithResults) =>
    post.platformResults?.some(
      (r) => r.status === "failed" && r.platform === "tiktok" && r.error_message &&
        (r.error_message.includes("picture_size_check_failed") || r.error_message.includes("video dimensions") || r.error_message.includes("resolution"))
    ) || post.platformResults?.some(
      (r) => r.status === "failed" && /Post media is unavailable|Only photo or video can be accepted as media type/i.test(r.error_message || "")
    );

  const openRetryDialog = (post: PostWithResults) => {
    const failedAccountIds = post.platformResults?.filter((r) => r.status === "failed" && r.social_account_id).map((r) => r.social_account_id as string) || [];
    setRetrySelectedAccountIds(failedAccountIds);
    setRetryDialogPost(post);
  };

  const openRetryMediaDialog = (post: PostWithResults) => {
    setRetryMediaDialogPost(post);
    setRetryMediaFiles([]);
  };

  const handleRetrySinglePlatform = async (postId: string, platformPostId: string, platform: string, accountId?: string | null) => {
    setRetryingPostId(postId);
    try {
      await deletePlatformPost(platformPostId);
      await invokeProcessPost(postId, [platform], accountId ? [accountId] : undefined);
      toast({ title: "Retry initiated", description: `Retrying ${platform}...` });
      invalidatePostQueries(queryClient);
    } catch (error) {
      console.error("Single platform retry error:", error);
      toast({ title: "Retry failed", description: error instanceof Error ? error.message : "Failed to retry platform", variant: "destructive" });
    } finally { setRetryingPostId(null); }
  };

  const handleRetryFailed = async (post: PostWithResults) => {
    const failedPlatforms = post.platformResults?.filter((r) => r.status === "failed").map((r) => r.platform) || [];
    if (failedPlatforms.length === 0) { toast({ title: "No failed platforms", description: "This post has no failed platforms to retry." }); return; }
    if (hasTikTokFailure(post)) { openRetryDialog(post); return; }

    if (failedRetryTargets(post.platformResults).accountIds.length === 0) {
      toast({ title: "Cannot retry automatically", description: "The failed results name no account. Retry them one at a time from the post's details.", variant: "destructive" });
      return;
    }

    setRetryingPostId(post.id);
    try {
      // Targets come from the rows actually removed, so a row that failed since the page loaded is retried too.
      const targets = failedRetryTargets(await takeFailedRetryRows(post.id));
      if (targets.accountIds.length === 0) throw new Error("This post has no failed platforms left to retry.");
      await invokeProcessPost(post.id, targets.platforms, targets.accountIds);
      toast({ title: "Retry initiated", description: `Retrying ${failedPlatforms.length} failed platform(s).` });
      invalidatePostQueries(queryClient);
    } catch (error) {
      console.error("Retry error:", error);
      toast({ title: "Retry failed", description: error instanceof Error ? error.message : "Failed to retry post", variant: "destructive" });
    } finally { setRetryingPostId(null); }
  };

  const handleRetryWithAccounts = async () => {
    if (!retryDialogPost || retrySelectedAccountIds.length === 0) return;
    setRetryLoading(true);
    try {
      await deleteFailedPlatformPosts(retryDialogPost.id);
      const { error: updateError } = await supabase.from("posts").update({
        metadata: { ...(retryDialogPost.metadata || {}), selected_account_ids: retrySelectedAccountIds },
      }).eq("id", retryDialogPost.id);
      if (updateError) throw updateError;
      await invokeProcessPost(retryDialogPost.id);
      toast({ title: "Retry initiated", description: `Retrying with ${retrySelectedAccountIds.length} selected account(s).` });
      invalidatePostQueries(queryClient);
      setRetryDialogPost(null);
    } catch (error) {
      console.error("Retry error:", error);
      toast({ title: "Retry failed", description: error instanceof Error ? error.message : "Failed to retry post", variant: "destructive" });
    } finally { setRetryLoading(false); }
  };

  const handleRetryWithNewMedia = async () => {
    if (!retryMediaDialogPost || retryMediaFiles.length === 0) return;
    setRetryMediaUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const settled = await Promise.allSettled(retryMediaFiles.map(async (retryMediaFile) => {
        const fileExt = retryMediaFile.name.split(".").pop() || "bin";
        const fileName = `${user.id}/${await buildPostoraFileName(user.id, fileExt)}`;
        const { data: uploadData, error: uploadError } = await supabase.storage.from("media").upload(fileName, retryMediaFile, { cacheControl: "3600", upsert: false });
        if (uploadError) throw uploadError;

        const isGif = retryMediaFile.type === "image/gif" || retryMediaFile.name.toLowerCase().endsWith(".gif");
        const fileType = retryMediaFile.type.startsWith("video") ? "video" : isGif ? "gif" : "image";
        const { data: newMediaFile, error: mediaError } = await supabase.from("media_files").insert({
          user_id: user.id, file_path: uploadData.path, file_type: fileType, file_size: retryMediaFile.size, mime_type: retryMediaFile.type, storage_bucket: "media",
        }).select().single();
        if (mediaError) {
          if (isMediaQuotaMessage(mediaError.message)) {
            await supabase.storage.from("media").remove([uploadData.path]);
            throw new Error(mediaQuotaHumanMessage(mediaError.message));
          }
          throw mediaError;
        }
        return newMediaFile;
      }));
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      const stored = settled
        .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (failed) {
        // One file failing (e.g. the daily limit) aborts the retry: drop the siblings that
        // did land so they are not left as unreferenced library rows and storage objects.
        if (stored.length > 0) {
          await supabase.from("media_files").delete().in("id", stored.map((mediaFile) => mediaFile.id));
          await supabase.storage.from("media").remove(stored.map((mediaFile) => mediaFile.file_path));
        }
        throw failed.reason;
      }
      const newMediaFiles = stored;

      await deleteFailedPlatformPosts(retryMediaDialogPost.id);
      const { error: updateError } = await supabase.from("posts").update({ media_file_ids: newMediaFiles.map((mediaFile) => mediaFile.id), status: "pending" }).eq("id", retryMediaDialogPost.id);
      if (updateError) throw updateError;

      await invokeProcessPost(retryMediaDialogPost.id);
      toast({ title: "Retry initiated with new media", description: `Your post is being processed with ${newMediaFiles.length} replacement media file(s).` });
      invalidatePostQueries(queryClient);
      setRetryMediaDialogPost(null);
      setRetryMediaFiles([]);
    } catch (error) {
      console.error("Retry with media error:", error);
      toast({ title: "Retry failed", description: error instanceof Error ? error.message : "Failed to retry post", variant: "destructive" });
    } finally { setRetryMediaUploading(false); }
  };

  const handleBulkRetry = async (failedPosts: PostWithResults[]) => {
    if (failedPosts.length === 0) { toast({ title: "No failed posts", description: "There are no failed posts to retry." }); return; }
    setBulkRetrying(true);
    setBulkRetryProgress({ current: 0, total: failedPosts.length });
    let successCount = 0, errorCount = 0;
    for (let i = 0; i < failedPosts.length; i++) {
      setBulkRetryProgress({ current: i + 1, total: failedPosts.length });
      try {
        const targets = failedRetryTargets(await takeFailedRetryRows(failedPosts[i].id));
        if (targets.accountIds.length === 0) throw new Error("No failed result names an account");
        await invokeProcessPost(failedPosts[i].id, targets.platforms, targets.accountIds);
        successCount++;
      }
      catch { errorCount++; }
    }
    setBulkRetrying(false);
    invalidatePostQueries(queryClient);
    toast({ title: "Bulk retry complete", description: `${successCount} post(s) retried successfully${errorCount > 0 ? `, ${errorCount} failed` : ""}.` });
  };

  const toggleRetryAccountSelection = (accountId: string) => {
    setRetrySelectedAccountIds((prev) => prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]);
  };

  return {
    retryingPostId, bulkRetrying, bulkRetryProgress,
    retryDialogPost, setRetryDialogPost, retrySelectedAccountIds, retryLoading,
    retryMediaDialogPost, setRetryMediaDialogPost, retryMediaFiles, setRetryMediaFiles, retryMediaUploading, retryMediaInputRef,
    handleRetryFailed, handleRetrySinglePlatform, handleRetryWithAccounts, handleRetryWithNewMedia,
    handleBulkRetry, openRetryMediaDialog, isTikTokMediaError, toggleRetryAccountSelection,
  };
}
