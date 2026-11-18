import { useTranslation } from "react-i18next";
import { enqueuePostPublish } from "@/features/publishing/infrastructure/enqueuePostPublish";
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildPostoraFileName } from "@/lib/postoraFileName";
import { isMediaQuotaMessage, mediaQuotaHumanMessage } from "@/components/media/uploadErrors";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  PostWithResults, invalidatePostQueries,
} from "./historyUtils";
import { failedRetryTargets, nonRetryableOutcome } from "./retryTargets";
import type { Platform } from "@/lib/types";

export function usePostRetry() {
  const { toast } = useToast();
  const { t } = useTranslation("history");
  const submitRetry = async (postId: string, accountIds?: string[], replacementMediaIds?: string[]) => {
    const acceptance = await enqueuePostPublish({ postId, mode: "retry", accountIds, replacementMediaIds });
    if (acceptance.accepted === false) {
      if (acceptance.reason === "invalid_media") {
        throw new Error("The replacement media is unavailable. Choose files from your media library and try again.");
      }
      if (acceptance.reason === "no_targets") {
        throw new Error("No destinations are currently eligible to retry. Refresh History to see the latest results.");
      }
      throw new Error(t("common:publishing.unconfirmed", "Could not confirm the publish request. Check History for its status."));
    }
  };
  const notifyRetrySubmitted = (platforms?: Platform[]) => toast({
    platforms,
    title: t("toast.retrySubmitted", "Retry submitted"),
    description: t("common:publishing.submitted", "Submitted, publishing"),
  });
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
  const uploadedRetryMedia = useRef<{ postId: string; files: File[]; ids: string[] } | null>(null);

  const isTikTokMediaError = (post: PostWithResults) =>
    post.platformResults?.some(
      (r) => r.status === "failed" && r.platform === "tiktok" && r.error_message &&
        (r.error_message.includes("picture_size_check_failed") || r.error_message.includes("video dimensions") || r.error_message.includes("resolution"))
    ) || post.platformResults?.some(
      (r) => r.status === "failed" && /Post media is unavailable|Only photo or video can be accepted as media type/i.test(r.error_message || "")
    );

  const openRetryDialog = (post: PostWithResults) => {
    setRetrySelectedAccountIds(failedRetryTargets(post.platformResults).accountIds);
    setRetryDialogPost(post);
  };

  const openRetryMediaDialog = (post: PostWithResults) => {
    uploadedRetryMedia.current = null;
    setRetryMediaDialogPost(post);
    setRetryMediaFiles([]);
  };

  const handleRetrySinglePlatform = async (postId: string, platformPostId: string, platform: string, accountId?: string | null) => {
    // Without an account, process-post would publish to every selected account on the platform.
    if (!accountId) {
      toast({ platform: platform as Platform, title: "Cannot retry this result", description: "It names no account. Create the post again for the account you want.", variant: "destructive" });
      return;
    }
    setRetryingPostId(postId);
    try {
      let detail: Record<string, unknown> | null = null;
      if (platform === "instagram") {
        const { data: result, error } = await supabase.from("platform_posts")
          .select("response_data").eq("id", platformPostId).eq("post_id", postId).maybeSingle();
        if (error || !result) throw new Error("Could not read this publication result.");
        detail = result.response_data as Record<string, unknown> | null;
      }
      if (platform === "instagram" && detail?.story_job_id) {
        const acceptance = await enqueuePostPublish({ postId, mode: "retry_story", resultId: platformPostId });
        if (!acceptance.accepted) throw new Error("This Story is not safely retryable. Check its current status.");
      } else {
        await submitRetry(postId, [accountId]);
      }
      notifyRetrySubmitted([platform as Platform]);
      invalidatePostQueries(queryClient);
    } catch (error) {
      console.error("Single platform retry error:", error);
      toast({ platform: platform as Platform, title: "Retry failed", description: error instanceof Error ? error.message : "Failed to retry platform", variant: "destructive" });
    } finally { setRetryingPostId(null); }
  };

  const handleRetryFailed = async (post: PostWithResults) => {
    const failedRows = post.platformResults?.filter((r) => r.status === "failed") ?? [];
    if (failedRows.length === 0) { toast({ title: "No failed platforms", description: "This post has no failed platforms to retry." }); return; }

    const retryTargets = failedRetryTargets(post.platformResults);
    if (retryTargets.accountIds.length === 0) {
      const protectedOutcomes = post.platformResults?.map(nonRetryableOutcome) ?? [];
      const uncertain = protectedOutcomes.includes("uncertain");
      const cancelled = protectedOutcomes.includes("cancelled");
      toast({
        title: uncertain || cancelled ? "This result cannot be retried" : "Cannot retry automatically",
        description: uncertain
          ? "Its outcome is not known: the destination may already have been published, so a retry could publish a second copy. Check that account by hand."
          : cancelled
            ? "Publishing was cancelled for this destination."
            : "The failed results name no account, so they cannot be retried without posting to every account again.",
        variant: "destructive",
      });
      return;
    }

    if (retryTargets.platforms.includes("tiktok")) { openRetryDialog(post); return; }

    setRetryingPostId(post.id);
    try {
      await submitRetry(post.id, retryTargets.accountIds);
      notifyRetrySubmitted(retryTargets.platforms as Platform[]);
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
      // The retry request records these accounts; the post's own selection stays as composed.
      await submitRetry(retryDialogPost.id, retrySelectedAccountIds);
      notifyRetrySubmitted();
      invalidatePostQueries(queryClient);
      setRetryDialogPost(null);
    } catch (error) {
      console.error("Retry error:", error);
      toast({ title: "Retry failed", description: error instanceof Error ? error.message : "Failed to retry post", variant: "destructive" });
    } finally { setRetryLoading(false); }
  };

  const uploadRetryMedia = async (files: File[]) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const settled = await Promise.allSettled(files.map(async (retryMediaFile) => {
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
    return stored.map((mediaFile) => mediaFile.id);
  };

  const handleRetryWithNewMedia = async () => {
    if (!retryMediaDialogPost || retryMediaFiles.length === 0) return;
    setRetryMediaUploading(true);
    try {
      const saved = uploadedRetryMedia.current;
      const postId = retryMediaDialogPost.id;
      const ids = saved?.postId === postId && saved.files === retryMediaFiles
        ? saved.ids
        : await uploadRetryMedia(retryMediaFiles);
      uploadedRetryMedia.current = { postId, files: retryMediaFiles, ids };
      await submitRetry(postId, undefined, ids);
      uploadedRetryMedia.current = null;
      notifyRetrySubmitted();
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
    let acceptedCount = 0, errorCount = 0;
    for (let i = 0; i < failedPosts.length; i++) {
      setBulkRetryProgress({ current: i + 1, total: failedPosts.length });
      try {
        await submitRetry(failedPosts[i].id);
        acceptedCount++;
      }
      catch { errorCount++; }
    }
    setBulkRetrying(false);
    invalidatePostQueries(queryClient);
    toast({
      title: t("toast.retryRequestsSubmitted", "Retry requests submitted"),
      description: t("toast.retryRequestsSummary", "{{accepted}} request(s) accepted, {{failed}} not confirmed. Check History for publishing results.", { accepted: acceptedCount, failed: errorCount }),
      ...(errorCount > 0 ? { variant: "destructive" as const } : {}),
    });
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
