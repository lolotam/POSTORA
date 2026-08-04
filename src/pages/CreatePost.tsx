import { useMemo, useState, useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Label } from "@/components/ui/label";
import { Platform } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { usePostForm } from "@/hooks/usePostForm";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { useMusicCopyright } from "@/hooks/useMusicCopyright";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useUserRole } from "@/hooks/useUserRole";
import { useYouTubeThumbnails } from "@/hooks/useYouTubeThumbnails";
import { useMediaEditors } from "@/hooks/useMediaEditors";
import { usePublishing } from "@/contexts/PublishingContext";
import { useUnsplashAttribution } from "@/hooks/useUnsplashAttribution";
import { supabase } from "@/integrations/supabase/client";
import { TIKTOK_PHOTO_WARNING } from "@/lib/platformConstants";
import { openExternalPostUrl } from "@/lib/openExternalPostUrl";
import { TikTokSettingsState } from "@/components/post/settings/TikTokSettings";
import { YouTubeSettingsState } from "@/components/post/settings/YouTubeSettings";
import { useSavedFieldSuggestions } from "@/hooks/useSavedFieldSuggestions";
import { useQuotas } from "@/hooks/useQuotas";

// Extracted components
import { CreatePostHeader } from "@/components/post/CreatePostHeader";
import { StepProgressBar, PostStep } from "@/components/post/StepProgressBar";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { UploadMethodSelector } from "@/components/post/UploadMethodSelector";
import { MediaUploadArea } from "@/components/post/MediaUploadArea";
import { CaptionSection } from "@/components/post/CaptionSection";
import { SchedulingSection } from "@/components/post/SchedulingSection";
import { AccountSelectionSidebar } from "@/components/post/AccountSelectionSidebar";
import { PostActions } from "@/components/post/PostActions";
import { PlatformSettingsSection } from "@/components/post/PlatformSettingsSection";
import { MediaEditorDialogs } from "@/components/post/MediaEditorDialogs";
import { MediaSummaryBanner } from "@/components/post/MediaSummaryBanner";
import { ProcessingStatusPanel } from "@/components/post/ProcessingStatusPanel";
import { TikTokForYouPreview } from "@/components/post/TikTokForYouPreview";
import { Icon3D, GradientDivider } from "@/components/fx";
import { ImagePlus, Type } from "lucide-react";

export default function CreatePost() {
  const { toast } = useToast();
  const location = useLocation();
  const { flags, isLoading: isFlagsLoading } = useFeatureFlags();
  const { isAdmin } = useUserRole();
  const { canCreatePost } = useQuotas();

  // Compute hidden platforms based on feature flags (admin sees all)
  const hiddenPlatforms = useMemo(() => {
    if (isAdmin) return [] as Platform[];
    const PLATFORM_FLAG_MAP: Record<Platform, string> = {
      facebook: "tabFacebook",
      instagram: "tabInstagram",
      threads: "tabThreads",
      tiktok: "tabTiktok",
      youtube: "tabYoutube",
      linkedin: "tabLinkedin",
      twitter: "tabTwitter",
      pinterest: "tabPinterest",
      bluesky: "tabBluesky",
      reddit: "tabReddit",
      whatsapp: "tabWhatsapp",
    };
    return (Object.entries(PLATFORM_FLAG_MAP) as [Platform, string][])
      .filter(([, flagKey]) => (flags as any)[flagKey] === false)
      .map(([platform]) => platform);
  }, [flags, isAdmin]);

  // Core form state hook
  const postForm = usePostForm();
  const {
    caption, setCaption,
    selectedPlatforms, setSelectedPlatforms,
    selectedAccountIds, setSelectedAccountIds,
    files, setFiles,
    isPosting, setIsPosting,
    isUploading,
    isDragging,
    scheduledAt, setScheduledAt,
    scheduleEnabled, setScheduleEnabled,
    scheduleTimezone, setScheduleTimezone,
    uploadMethod, setUploadMethod,
    platformFilter, setPlatformFilter,
    fileInputRef,
    availableAccounts,
    accountsByPlatform,
    allPlatforms,
    filteredAccountsForUploadMethod,
    hasOnlyImages,
    hasVideo,
    hasCharacterError,
    accountsLoading,
    connectedAccounts,
    user,
    profile,
    mediaAnalysis,
    platformEligibility,
    eligiblePlatforms,
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeFile,
    updatePlatformSelection,
    handlePlatformFilterToggle,
    resetPostForm,
    validatePost,
    uploadFileToStorage,
    showSuccessToast,
    showErrorToast,
    uploadUrlToStorage,
    editPostId,
    isLoadingEditPost,
  } = postForm;

  // Platform settings hook
  const platformSettings = usePlatformSettings(user?.id, selectedAccountIds, selectedPlatforms);

  // Music copyright hook
  const { checkMusicCopyright, isChecking: isCheckingMusic, result: musicCopyrightResult } = useMusicCopyright();

  // YouTube thumbnail hook
  const youtubeThumbnails = useYouTubeThumbnails({
    files,
    setYoutubeAutoThumbnails: platformSettings.setYoutubeAutoThumbnails,
    setYoutubeSelectedAutoThumbnail: platformSettings.setYoutubeSelectedAutoThumbnail,
    setYoutubeAiGeneratedThumbnails: platformSettings.setYoutubeAiGeneratedThumbnails,
    setYoutubeGeneratingAiThumbnail: platformSettings.setYoutubeGeneratingAiThumbnail,
  });

  // Media editors hook (cropper + compressor)
  const mediaEditors = useMediaEditors({
    files,
    setFiles,
    uploadFileToStorage,
    user,
    flags,
    isFlagsLoading,
  });

  // Realtime updates for publishing progress (from context)
  const { trackPublishingPost, clearPublishingPost } = usePublishing();

  // Unsplash attribution management
  const {
    requiredAttribution: unsplashAttribution,
    isAttributionValid,
    validationError: unsplashValidationError,
    hasUnsplashImages,
  } = useUnsplashAttribution({
    files,
    caption,
    setCaption,
    autoAppend: true, // Auto-append attribution when Unsplash images are added
  });

  // Pre-fill caption from Brand Intelligence "Use in Post"
  useEffect(() => {
    if (location.state?.caption && !caption) {
      setCaption(location.state.caption);
    }
  }, [location.state]);

  // UI state
  const [currentStep, setCurrentStep] = useState<PostStep>(1);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [urlMediaType, setUrlMediaType] = useState<"images" | "video">("images");
  const [imageUrls, setImageUrls] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [platformSettingsOpen, setPlatformSettingsOpen] = useState(true);
  const [schedulingOpen, setSchedulingOpen] = useState(true);

  // Build map of ALL selected accounts per platform (for preview identity switching)
  const previewIdentitiesByPlatform = useMemo(() => {
    const map: Partial<Record<Platform, { id: string; username?: string | null; avatarUrl?: string | null }[]>> = {};
    for (const id of selectedAccountIds) {
      const acc = connectedAccounts.find((a) => a.id === id);
      if (!acc) continue;
      if (!map[acc.platform]) map[acc.platform] = [];
      map[acc.platform]!.push({ id: acc.id, username: acc.platform_username, avatarUrl: acc.avatar_url });
    }
    return map;
  }, [connectedAccounts, selectedAccountIds]);

  // Handle account toggle
  const handleAccountToggle = async (accountId: string, platform: Platform) => {
    const isAdding = !selectedAccountIds.includes(accountId);

    if (isAdding && platform === "tiktok" && hasOnlyImages) {
      showErrorToast(TIKTOK_PHOTO_WARNING.title, TIKTOK_PHOTO_WARNING.message);
      return;
    }

    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    );
    updatePlatformSelection(isAdding, platform, accountId, selectedAccountIds);

    if (platform === "pinterest" && isAdding) {
      platformSettings.fetchPinterestBoards();
    } else if (platform === "pinterest" && !isAdding) {
      const remaining = selectedAccountIds.filter(id =>
        connectedAccounts.find(a => a.id === id && a.platform === "pinterest")
      ).length;
      if (remaining <= 1) {
        platformSettings.setPinterestBoards([]);
        platformSettings.setSelectedPinterestBoard("");
      }
    }

    if (platform === "tiktok" && isAdding) {
      platformSettings.fetchTiktokCreatorInfo(accountId);
    }
  };

  // Handle Select All for a platform
  const handleSelectAllPlatform = (platform: Platform) => {
    if (platform === "tiktok" && hasOnlyImages) {
      toast({ title: TIKTOK_PHOTO_WARNING.title, description: TIKTOK_PHOTO_WARNING.message, variant: "destructive" });
      return;
    }

    const platformAccounts = accountsByPlatform[platform] || [];
    const platformAccountIds = platformAccounts.map(acc => acc.id);
    const allSelected = platformAccountIds.every(id => selectedAccountIds.includes(id));

    if (allSelected) {
      setSelectedAccountIds(prev => prev.filter(id => !platformAccountIds.includes(id)));
      setSelectedPlatforms(prev => prev.filter(p => p !== platform));
      if (platform === "pinterest") {
        platformSettings.setPinterestBoards([]);
        platformSettings.setSelectedPinterestBoard("");
      }
    } else {
      setSelectedAccountIds(prev => [...new Set([...prev, ...platformAccountIds])]);
      if (!selectedPlatforms.includes(platform)) {
        setSelectedPlatforms(prev => [...prev, platform]);
      }
      if (platform === "pinterest") {
        platformSettings.fetchPinterestBoards();
      }
    }
  };

  // Build TikTok settings state
  const tiktokSettingsState: TikTokSettingsState = {
    privacyLevel: platformSettings.tiktokPrivacyLevel,
    allowComment: platformSettings.tiktokAllowComment,
    allowDuet: platformSettings.tiktokAllowDuet,
    allowStitch: platformSettings.tiktokAllowStitch,
    title: platformSettings.tiktokTitle,
    discloseContent: platformSettings.tiktokDiscloseContent,
    yourBrand: platformSettings.tiktokYourBrand,
    brandedContent: platformSettings.tiktokBrandedContent,
    aiGenerated: platformSettings.tiktokAiGenerated,
    consentAgreed: platformSettings.tiktokConsentAgreed,
    musicCheck: platformSettings.tiktokMusicCheck,
    contentCheck: platformSettings.tiktokContentCheck,
  };

  const handleTiktokSettingsChange = (changes: Partial<TikTokSettingsState>) => {
    if (changes.privacyLevel !== undefined) platformSettings.setTiktokPrivacyLevel(changes.privacyLevel);
    if (changes.allowComment !== undefined) platformSettings.setTiktokAllowComment(changes.allowComment);
    if (changes.allowDuet !== undefined) platformSettings.setTiktokAllowDuet(changes.allowDuet);
    if (changes.allowStitch !== undefined) platformSettings.setTiktokAllowStitch(changes.allowStitch);
    if (changes.title !== undefined) platformSettings.setTiktokTitle(changes.title);
    if (changes.discloseContent !== undefined) platformSettings.setTiktokDiscloseContent(changes.discloseContent);
    if (changes.yourBrand !== undefined) platformSettings.setTiktokYourBrand(changes.yourBrand);
    if (changes.brandedContent !== undefined) platformSettings.setTiktokBrandedContent(changes.brandedContent);
    if (changes.aiGenerated !== undefined) platformSettings.setTiktokAiGenerated(changes.aiGenerated);
    if (changes.consentAgreed !== undefined) platformSettings.setTiktokConsentAgreed(changes.consentAgreed);
    if (changes.musicCheck !== undefined) platformSettings.setTiktokMusicCheck(changes.musicCheck);
    if (changes.contentCheck !== undefined) platformSettings.setTiktokContentCheck(changes.contentCheck);
  };

  // Build YouTube settings state
  const youtubeSettingsState: YouTubeSettingsState = {
    videoType: platformSettings.youtubeVideoType,
    title: platformSettings.youtubeTitle,
    description: platformSettings.youtubeDescription,
    visibility: platformSettings.youtubeVisibility,
    tags: platformSettings.youtubeTags,
    category: platformSettings.youtubeCategory,
    madeForKids: platformSettings.youtubeMadeForKids,
    allowEmbedding: platformSettings.youtubeAllowEmbedding,
    publicStatsViewable: platformSettings.youtubePublicStatsViewable,
    containsSyntheticMedia: platformSettings.youtubeContainsSyntheticMedia,
    hasPaidPromotion: platformSettings.youtubeHasPaidPromotion,
    notifySubscribers: platformSettings.youtubeNotifySubscribers,
    commentsEnabled: platformSettings.youtubeCommentsEnabled,
    commentModeration: platformSettings.youtubeCommentModeration,
    whoCanComment: platformSettings.youtubeWhoCanComment,
    commentSortBy: platformSettings.youtubeCommentSortBy,
    showLikeCount: platformSettings.youtubeShowLikeCount,
    shortsRemixing: platformSettings.youtubeShortsRemixing,
    recordingDate: platformSettings.youtubeRecordingDate,
    videoLocation: platformSettings.youtubeVideoLocation,
    license: platformSettings.youtubeLicense,
    videoLanguage: platformSettings.youtubeVideoLanguage,
    audioLanguage: platformSettings.youtubeAudioLanguage,
    captionCertification: platformSettings.youtubeCaptionCertification,
    titleDescLanguage: platformSettings.youtubeTitleDescLanguage,
    thumbnailMode: platformSettings.youtubeThumbnailMode,
    thumbnailUrl: platformSettings.youtubeThumbnailUrl,
    thumbnailFile: platformSettings.youtubeThumbnailFile,
    playlist: platformSettings.youtubePlaylist,
    allowedCountries: platformSettings.youtubeAllowedCountries,
    blockedCountries: platformSettings.youtubeBlockedCountries,
    firstComment: platformSettings.youtubeFirstComment,
    enableFirstComment: platformSettings.youtubeEnableFirstComment,
  };

  const handleYoutubeSettingsChange = (changes: Partial<YouTubeSettingsState>) => {
    if (changes.videoType !== undefined) platformSettings.setYoutubeVideoType(changes.videoType);
    if (changes.title !== undefined) platformSettings.setYoutubeTitle(changes.title);
    if (changes.description !== undefined) platformSettings.setYoutubeDescription(changes.description);
    if (changes.visibility !== undefined) platformSettings.setYoutubeVisibility(changes.visibility);
    if (changes.tags !== undefined) platformSettings.setYoutubeTags(changes.tags);
    if (changes.category !== undefined) platformSettings.setYoutubeCategory(changes.category);
    if (changes.madeForKids !== undefined) platformSettings.setYoutubeMadeForKids(changes.madeForKids);
    if (changes.allowEmbedding !== undefined) platformSettings.setYoutubeAllowEmbedding(changes.allowEmbedding);
    if (changes.publicStatsViewable !== undefined) platformSettings.setYoutubePublicStatsViewable(changes.publicStatsViewable);
    if (changes.containsSyntheticMedia !== undefined) platformSettings.setYoutubeContainsSyntheticMedia(changes.containsSyntheticMedia);
    if (changes.hasPaidPromotion !== undefined) platformSettings.setYoutubeHasPaidPromotion(changes.hasPaidPromotion);
    if (changes.notifySubscribers !== undefined) platformSettings.setYoutubeNotifySubscribers(changes.notifySubscribers);
    if (changes.commentsEnabled !== undefined) platformSettings.setYoutubeCommentsEnabled(changes.commentsEnabled);
    if (changes.commentModeration !== undefined) platformSettings.setYoutubeCommentModeration(changes.commentModeration);
    if (changes.whoCanComment !== undefined) platformSettings.setYoutubeWhoCanComment(changes.whoCanComment);
    if (changes.commentSortBy !== undefined) platformSettings.setYoutubeCommentSortBy(changes.commentSortBy);
    if (changes.showLikeCount !== undefined) platformSettings.setYoutubeShowLikeCount(changes.showLikeCount);
    if (changes.shortsRemixing !== undefined) platformSettings.setYoutubeShortsRemixing(changes.shortsRemixing);
    if (changes.recordingDate !== undefined) platformSettings.setYoutubeRecordingDate(changes.recordingDate);
    if (changes.videoLocation !== undefined) platformSettings.setYoutubeVideoLocation(changes.videoLocation);
    if (changes.license !== undefined) platformSettings.setYoutubeLicense(changes.license);
    if (changes.videoLanguage !== undefined) platformSettings.setYoutubeVideoLanguage(changes.videoLanguage);
    if (changes.audioLanguage !== undefined) platformSettings.setYoutubeAudioLanguage(changes.audioLanguage);
    if (changes.captionCertification !== undefined) platformSettings.setYoutubeCaptionCertification(changes.captionCertification);
    if (changes.titleDescLanguage !== undefined) platformSettings.setYoutubeTitleDescLanguage(changes.titleDescLanguage);
    if (changes.thumbnailMode !== undefined) platformSettings.setYoutubeThumbnailMode(changes.thumbnailMode);
    if (changes.thumbnailUrl !== undefined) platformSettings.setYoutubeThumbnailUrl(changes.thumbnailUrl);
    if (changes.thumbnailFile !== undefined) platformSettings.setYoutubeThumbnailFile(changes.thumbnailFile);
    if (changes.playlist !== undefined) platformSettings.setYoutubePlaylist(changes.playlist);
    if (changes.allowedCountries !== undefined) platformSettings.setYoutubeAllowedCountries(changes.allowedCountries);
    if (changes.blockedCountries !== undefined) platformSettings.setYoutubeBlockedCountries(changes.blockedCountries);
    if (changes.firstComment !== undefined) platformSettings.setYoutubeFirstComment(changes.firstComment);
    if (changes.enableFirstComment !== undefined) platformSettings.setYoutubeEnableFirstComment(changes.enableFirstComment);
  };

  // Validate and post
  const handlePost = async () => {
    if (!validatePost(unsplashValidationError)) return;

    // Enforce daily/monthly post quotas on new posts (edits reuse existing row)
    if (!editPostId) {
      const quotaCheck = await canCreatePost();
      if (!quotaCheck.allowed) {
        showErrorToast("Post limit reached", quotaCheck.message || "You've reached your post quota.");
        return;
      }
    }

    if (selectedPlatforms.includes("tiktok")) {
      const tiktokError = platformSettings.validateTiktokSettings(hasVideo);
      if (tiktokError) {
        showErrorToast("TikTok validation failed", tiktokError);
        return;
      }
    }

    if (selectedPlatforms.includes("pinterest")) {
      const pinterestError = platformSettings.validatePinterestSettings();
      if (pinterestError) {
        showErrorToast("Pinterest validation failed", pinterestError);
        return;
      }
    }

    setIsPosting(true);

    try {
      // Debug: Log files state before extracting media IDs
      console.log("[CreatePost] Files state:", files.map(f => ({
        id: f.id,
        uploaded: f.uploaded,
        storagePath: f.storagePath,
        fileType: f.fileType,
        fromMediaLibrary: f.fromMediaLibrary,
        cloudinaryUrl: f.cloudinaryUrl?.slice(0, 50),
      })));

      let mediaFileIds = files.filter((f) => f.uploaded && f.storagePath).map((f) => f.storagePath!);

      // Defensive guard: warn if files exist but none have storagePath
      const uploadedWithoutPath = files.filter((f) => f.uploaded && !f.storagePath);
      if (uploadedWithoutPath.length > 0 && mediaFileIds.length === 0) {
        console.warn("[CreatePost] WARNING: uploaded files missing storagePath — media will not attach:", 
          uploadedWithoutPath.map(f => ({ id: f.id, fileType: f.fileType, fromMediaLibrary: f.fromMediaLibrary }))
        );
      }

      // Handle URL upload method - persist URLs to storage
      if (uploadMethod === "url") {
        if (urlMediaType === "images" && imageUrls.trim()) {
          const urls = imageUrls.split("\n").map(u => u.trim()).filter(u => u);
          if (urls.length > 0) {
            console.log("[CreatePost] Processing URL uploads for images:", urls.length);
            const uploaded = await Promise.all(urls.map(url => uploadUrlToStorage(url, "image")));
            const newIds = uploaded.filter(u => u !== null).map(u => u!.id);
            mediaFileIds = [...mediaFileIds, ...newIds];
          }
        } else if (urlMediaType === "video" && videoUrl.trim()) {
          console.log("[CreatePost] Processing URL upload for video");
          const uploaded = await uploadUrlToStorage(videoUrl.trim(), "video");
          if (uploaded) {
            mediaFileIds = [...mediaFileIds, uploaded.id];
          }
        }
      }

      console.log("[CreatePost] Extracted media file IDs:", mediaFileIds);

      // Defensive: derive platforms from selected accounts (prevents empty platforms edge-cases)
      const platformsForInsert = Array.from(
        new Set(
          selectedAccountIds
            .map((id) => connectedAccounts.find((a) => a.id === id)?.platform)
            .filter(Boolean)
        )
      ) as Platform[];

      const postPayload = {
        user_id: user?.id,
        caption: caption.trim() || null,
        platforms: platformsForInsert,
        media_file_ids: mediaFileIds.length > 0 ? mediaFileIds : null,
        scheduled_at: scheduleEnabled && scheduledAt ? scheduledAt.toISOString() : null,
        status: scheduleEnabled && scheduledAt ? "scheduled" : "pending",
        metadata: {
          ...platformSettings.buildPostMetadata(),
          schedule_timezone: scheduleTimezone || null,
        },
      };

      let post: any;

      if (editPostId) {
        // Update existing post
        const { data, error } = await supabase
          .from("posts")
          .update(postPayload)
          .eq("id", editPostId)
          .select()
          .single();
        if (error) throw error;
        post = data;
      } else {
        // Create new post (DB trigger also enforces quota server-side)
        const { data, error } = await supabase
          .from("posts")
          .insert(postPayload)
          .select()
          .single();
        if (error) {
          const msg = error.message || "";
          if (msg.includes("POST_QUOTA_DAILY_EXCEEDED") || msg.includes("POST_QUOTA_MONTHLY_EXCEEDED")) {
            showErrorToast(
              "Post limit reached",
              msg.replace(/^.*POST_QUOTA_[A-Z_]+:\s*/i, "") || "You've reached your post quota."
            );
            return;
          }
          throw error;
        }
        post = data;
      }

      // Save field suggestions for future reuse (fire and forget)
      const saveFieldSuggestions = async () => {
        try {
          const db = supabase as any;
          const uid = user?.id;
          if (!uid) return;

          const saveSuggestion = async (fieldType: string, value: string, platform: string | null, isComma = false) => {
            if (!value.trim()) return;
            const vals = isComma ? value.split(",").map(v => v.trim()).filter(Boolean) : [value.trim()];
            for (const val of vals) {
              let q = db.from("saved_field_suggestions").select("id, use_count").eq("user_id", uid).eq("field_type", fieldType).eq("value", val);
              q = platform ? q.eq("platform", platform) : q.is("platform", null);
              const { data: existing } = await q.maybeSingle();
              if (existing) {
                await db.from("saved_field_suggestions").update({ use_count: existing.use_count + 1, last_used_at: new Date().toISOString() }).eq("id", existing.id);
              } else {
                await db.from("saved_field_suggestions").insert({ user_id: uid, field_type: fieldType, value: val, platform });
              }
            }
          };

          
          if (platformSettings.facebookReelCollaborator) await saveSuggestion("collaborator", platformSettings.facebookReelCollaborator, "facebook");
          if (platformSettings.instagramCollaborator) await saveSuggestion("collaborator", platformSettings.instagramCollaborator, "instagram");
        } catch (e) {
          console.warn("[CreatePost] Failed to save field suggestions:", e);
        }
      };
      saveFieldSuggestions();

      if (!scheduleEnabled || !scheduledAt) {
        // Track this post for realtime updates
        trackPublishingPost(post.id, platformsForInsert);

        // Optimistic publishing: Show success immediately, process in background
        toast({
          title: "Publishing...",
          description: (
            <div className="space-y-2">
              <p>Your post is being published to {selectedAccountIds.length} account(s).</p>
              <p className="text-xs text-muted-foreground">
                Check the History page for real-time status updates.
              </p>
            </div>
          ),
          duration: 5000,
        });

        // Fire and forget - don't await the edge function
        supabase.functions.invoke("process-post", {
          body: { post_id: post.id },
        }).then(({ data: result, error: funcError }) => {
          // CRITICAL: Always clear publishing state when edge function returns
          clearPublishingPost(post.id);

          if (funcError) {
            console.error("Background publish error:", funcError);
            toast({
              title: "Publishing issue",
              description: "Some platforms may have failed. Check History for details.",
              variant: "destructive",
              duration: 8000,
            });
            return;
          }

          // Show success notification with links when done
          if (result?.status === "completed" && result?.platform_results) {
            const successfulPosts = result.platform_results.filter((p: any) => p.status === "success" && p.platform_post_url);
            if (successfulPosts.length > 0) {
              toast({
                title: "Post published!",
                description: (
                  <div className="space-y-2">
                    <p>Your post has been published successfully.</p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {successfulPosts.map((p: any) => (
                        <a
                          key={p.platform}
                          href={p.platform_post_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          referrerPolicy="no-referrer"
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          onClick={(e) => {
                            e.preventDefault();
                            openExternalPostUrl(p.platform_post_url);
                          }}
                        >
                          View on {p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}
                        </a>
                      ))}
                    </div>
                  </div>
                ),
                duration: 10000,
              });
            }
          }

          // Show TikTok inbox reminder
          if (selectedPlatforms.includes("tiktok")) {
            setTimeout(() => {
              showSuccessToast("Check your TikTok inbox", "TikTok posts are sent to your inbox. Open the TikTok app to complete posting.");
            }, 1000);
          }
        }).catch((error) => {
          console.error("Background publish error:", error);
          // Clear publishing state even on error
          clearPublishingPost(post.id);
        });
      } else {
        const actionLabel = editPostId ? "Post updated & scheduled!" : "Post scheduled!";
        showSuccessToast(actionLabel, `Your post will be published on ${scheduledAt.toLocaleDateString()} at ${scheduledAt.toLocaleTimeString()}.`);
      }

      // Reset form immediately for optimistic UX
      resetPostForm();
      platformSettings.resetTiktokSettings();

    } catch (error) {
      console.error("Post error:", error);
      showErrorToast("Post failed", error);
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 pb-8">
        <CreatePostHeader
          currentStep={currentStep}
          onDiscardDraft={resetPostForm}
          hasDraft={!!(caption || files.length > 0 || selectedAccountIds.length > 0)}
          selectedPlatforms={selectedPlatforms}
          connectedAccounts={connectedAccounts}
          selectedAccountIds={selectedAccountIds}
        />

        <StepProgressBar
          currentStep={currentStep}
          onStepChange={setCurrentStep}
        />

        {/* Step 1: Content */}
        {currentStep === 1 && (
          <div className="rounded-xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden animate-fade-in transition-all duration-300 hover:translate-y-[-2px]" style={{ perspective: '1000px', boxShadow: '0 4px 6px -1px hsl(var(--primary) / 0.06), 0 10px 30px -5px hsl(var(--primary) / 0.1), 0 1px 3px 0 hsl(var(--border) / 0.3)' }}>
            {/* Upload Media Section */}
            <div className="p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Icon3D icon={ImagePlus} variant="violet" size="sm" />
                  <div>
                    <Label className="text-base font-semibold leading-tight bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 bg-clip-text text-transparent">
                      Upload Media
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Add images, videos or GIFs for your post
                    </p>
                  </div>
                </div>
              </div>

              <GradientDivider tone="violet" />

              <UploadMethodSelector
                uploadMethod={uploadMethod}
                setUploadMethod={setUploadMethod}
                setSelectedAccountIds={setSelectedAccountIds}
                connectedAccounts={connectedAccounts}
                user={user}
                setFiles={setFiles}
                uploadFileToStorage={uploadFileToStorage}
                currentFileCount={files.length}
                isDragActive={isDragging}
              />

              <MediaUploadArea
                uploadMethod={uploadMethod}
                files={files}
                isDragging={isDragging}
                isUploading={isUploading}
                selectedPlatforms={selectedPlatforms}
                urlMediaType={urlMediaType}
                setUrlMediaType={setUrlMediaType}
                imageUrls={imageUrls}
                setImageUrls={setImageUrls}
                videoUrl={videoUrl}
                setVideoUrl={setVideoUrl}
                fileInputRef={fileInputRef}
                onFileSelect={handleFileSelect}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onRemoveFile={removeFile}
                onOpenCropper={mediaEditors.openCropper}
                onOpenCompressor={mediaEditors.openCompressor}
                onImageCropRequest={mediaEditors.handleImageCropRequest}
                onReorderFiles={setFiles}
                mediaAnalysis={mediaAnalysis}
                platformEligibility={platformEligibility}
                allPlatforms={allPlatforms}
              />

              {mediaEditors.processingJobs.length > 0 && (
                <ProcessingStatusPanel
                  jobs={mediaEditors.processingJobs}
                  onRetry={mediaEditors.onRetryJob}
                  onDismiss={mediaEditors.onDismissJob}
                  onClear={mediaEditors.onClearJobs}
                />
              )}
            </div>

            <Separator />

            {/* Caption & Details Section */}
            <div className="p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Icon3D icon={Type} variant="sky" size="sm" />
                  <div>
                    <Label className="text-base font-semibold leading-tight bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 bg-clip-text text-transparent">
                      Caption & Details
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Write your post caption
                    </p>
                  </div>
                </div>
              </div>

              <GradientDivider tone="sky" />

              <CaptionSection
                caption={caption}
                setCaption={setCaption}
                selectedPlatforms={selectedPlatforms}
                aiModel={profile?.ai_model}
                showSuccessToast={showSuccessToast}
                unsplashAttribution={unsplashAttribution}
                isAttributionValid={isAttributionValid}
              />
            </div>

            {/* Card Footer */}
            <div className="px-5 sm:px-6 py-4 border-t border-border flex justify-end" style={{ background: 'linear-gradient(to top, hsl(var(--muted) / 0.5), hsl(var(--muted) / 0.2))' }}>
              <Button onClick={() => setCurrentStep(2)} className="gap-2 shadow-md hover:shadow-lg transition-shadow">
                Next: Select Platforms
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Platforms */}
        {currentStep === 2 && (
          <div className="rounded-xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden animate-fade-in transition-all duration-300 hover:translate-y-[-2px]" style={{ perspective: '1000px', boxShadow: '0 4px 6px -1px hsl(var(--primary) / 0.06), 0 10px 30px -5px hsl(var(--primary) / 0.1), 0 1px 3px 0 hsl(var(--border) / 0.3)' }}>
            <div className="p-5 sm:p-6 space-y-4">
              {files.length > 0 && (
                <MediaSummaryBanner
                  analysis={mediaAnalysis}
                  eligibleCount={eligiblePlatforms.length}
                  totalPlatforms={allPlatforms.length}
                />
              )}
              <AccountSelectionSidebar
                availableAccounts={availableAccounts}
                accountsByPlatform={accountsByPlatform}
                filteredAccountsForUploadMethod={filteredAccountsForUploadMethod}
                allPlatforms={allPlatforms}
                selectedAccountIds={selectedAccountIds}
                selectedPlatforms={selectedPlatforms}
                platformFilter={platformFilter}
                caption={caption}
                hasOnlyImages={hasOnlyImages}
                accountsLoading={accountsLoading}
                onAccountToggle={handleAccountToggle}
                onSelectAllPlatform={handleSelectAllPlatform}
                onPlatformFilterToggle={handlePlatformFilterToggle}
                onClearFilter={() => setPlatformFilter([])}
                platformEligibility={platformEligibility}
                mediaAnalysis={mediaAnalysis}
              />
            </div>

            {/* Platform Settings */}
            {selectedPlatforms.length > 0 && (
              <>
                <Separator />
                <PlatformSettingsSection
                  isOpen={platformSettingsOpen}
                  onOpenChange={setPlatformSettingsOpen}
                  uploadMethod={uploadMethod}
                  files={files}
                  caption={caption}
                  setCaption={setCaption}
                  hasVideo={hasVideo}
                  hasOnlyImages={hasOnlyImages}
                  selectedPlatforms={selectedPlatforms}
                  selectedAccountIds={selectedAccountIds}
                  connectedAccounts={connectedAccounts}
                  platformSettings={platformSettings}
                  tiktokSettingsState={tiktokSettingsState}
                  onTiktokSettingsChange={handleTiktokSettingsChange}
                  youtubeSettingsState={youtubeSettingsState}
                  onYoutubeSettingsChange={handleYoutubeSettingsChange}
                  youtubeThumbnails={youtubeThumbnails}
                  musicCopyright={{
                    isChecking: isCheckingMusic,
                    result: musicCopyrightResult,
                    checkMusicCopyright,
                  }}
                  isPosting={isPosting}
                  scheduleEnabled={scheduleEnabled}
                  toast={toast}
                  supabase={supabase}
                  flags={flags}
                  onPost={handlePost}
                   ineligiblePlatforms={isAdmin ? [] : platformEligibility.filter(e => !e.isEligible).map(e => e.platform)}
                   hiddenPlatforms={hiddenPlatforms}
                 />
                {selectedPlatforms.includes("tiktok") && hasVideo && files.find(f => f.fileType === "video") && (
                  <div className="p-5 sm:p-6">
                    <TikTokForYouPreview
                      caption={caption}
                      mediaFile={files.find(f => f.fileType === "video") ? {
                        previewUrl: files.find(f => f.fileType === "video")!.previewUrl,
                        fileType: "video"
                      } : undefined}
                      username={connectedAccounts.find(a => a.platform === "tiktok" && selectedAccountIds.includes(a.id))?.platform_username || "your_account"}
                      avatarUrl={connectedAccounts.find(a => a.platform === "tiktok" && selectedAccountIds.includes(a.id))?.avatar_url || undefined}
                      soundName={platformSettings.tiktokTitle || "Original sound"}
                    />
                  </div>
                )}
              </>
            )}

            {/* Card Footer */}
            <div className="px-5 sm:px-6 py-4 border-t border-border flex justify-between" style={{ background: 'linear-gradient(to top, hsl(var(--muted) / 0.5), hsl(var(--muted) / 0.2))' }}>
              <Button variant="outline" onClick={() => setCurrentStep(1)} className="gap-2 shadow-sm hover:shadow-md transition-shadow">
                Back
              </Button>
              <Button onClick={() => setCurrentStep(3)} className="gap-2 shadow-md hover:shadow-lg transition-shadow">
                Next: Review & Schedule
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Schedule & Publish */}
        {currentStep === 3 && (
          <div className="rounded-xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden animate-fade-in transition-all duration-300 hover:translate-y-[-2px]" style={{ perspective: '1000px', boxShadow: '0 4px 6px -1px hsl(var(--primary) / 0.06), 0 10px 30px -5px hsl(var(--primary) / 0.1), 0 1px 3px 0 hsl(var(--border) / 0.3)' }}>
            <div className="p-5 sm:p-6">
              <SchedulingSection
                isOpen={schedulingOpen}
                onOpenChange={setSchedulingOpen}
                scheduleEnabled={scheduleEnabled}
                setScheduleEnabled={setScheduleEnabled}
                scheduledAt={scheduledAt}
                setScheduledAt={setScheduledAt}
                scheduleTimezone={scheduleTimezone}
                setScheduleTimezone={setScheduleTimezone}
                selectedPlatforms={selectedPlatforms}
              />
            </div>

            {/* Card Footer with Post Actions */}
            <div className="px-5 sm:px-6 pb-5">
              <PostActions
                isPosting={isPosting}
                isUploading={isUploading}
                hasCharacterError={hasCharacterError}
                selectedAccountIds={selectedAccountIds}
                scheduleEnabled={scheduleEnabled}
                scheduledAt={scheduledAt}
                selectedPlatforms={selectedPlatforms}
                caption={caption}
                mediaFiles={files.map((f) => ({
                  previewUrl: f.previewUrl,
                  fileType: f.fileType,
                  mediaSource: f.mediaSource,
                  photographerName: f.photographerName,
                  photographerUrl: f.photographerUrl,
                  unsplashUrl: f.unsplashUrl,
                }))}
                username={profile?.full_name || connectedAccounts[0]?.platform_username || "Your Account"}
                platformIdentities={previewIdentitiesByPlatform}
                previewOpen={previewOpen}
                setPreviewOpen={setPreviewOpen}
                onPost={handlePost}
                onBack={() => setCurrentStep(2)}
                hasAttributionError={hasUnsplashImages && !isAttributionValid}
              />
            </div>
          </div>
        )}

        {/* Media Editor Dialogs */}
        <MediaEditorDialogs
          cropperState={mediaEditors.cropperState}
          compressorState={mediaEditors.compressorState}
          selectedPlatforms={selectedPlatforms}
          onCloseCropper={mediaEditors.closeCropper}
          onCloseCompressor={mediaEditors.closeCompressor}
          onCropComplete={mediaEditors.handleCropComplete}
          onCompressComplete={mediaEditors.handleCompressComplete}
        />
      </div>
    </DashboardLayout>
  );
}
