import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Platform } from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { platformCharLimits, MEDIA_REQUIRED_PLATFORMS } from "@/lib/platformConstants";
import { validateMediaForPlatformsAsync, compressImage, ValidationResult } from "@/lib/imageUtils";
import { checkFileSizeForPlatforms } from "@/components/post/VideoPreview";
import { analyzeMedia, MediaAnalysis } from "@/lib/mediaAnalyzer";
import { getAllPlatformEligibility, PlatformEligibility } from "@/lib/platformEligibility";
import { resolveMediaPublicUrl } from "@/lib/mediaUrl";
import { formatUploadLimit, maxUploadBytesFor, mediaTypeForFileName, needsDirectUpload } from "@/lib/mediaTypes";
import { uploadLargeMedia, useMediaUploadLimits } from "@/features/media-upload";
import { getMissingMediaFileIds, orderPostMediaFiles } from "../../supabase/functions/_shared/post-media";

export interface UploadedFile {
  id: string;
  file: File;
  previewUrl: string;
  fileType: "image" | "video" | "gif";
  uploadProgress: number;
  uploaded: boolean;
  uploadError?: string;
  storagePath?: string;
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
  fromMediaLibrary?: boolean;
  altText?: string;
  /** Media source for attribution */
  mediaSource?: "klipy" | "pexels" | "pixabay" | "giphy" | "unsplash" | "local";
  /** Unsplash only: photographer name */
  photographerName?: string;
  /** Unsplash only: photographer profile URL with UTM */
  photographerUrl?: string;
  /** Unsplash only: Unsplash URL with UTM */
  unsplashUrl?: string;
}

interface MediaLibrarySelection {
  id: string;
  url: string;
  fileType: "image" | "video" | "gif";
  fileName: string;
  size: number;
  storageBucket: string;
  cloudinaryPublicId?: string;
}

const POST_DRAFT_KEY = "postora_post_draft";

interface PostDraftState {
  draftVersion?: string;
  caption: string;
  selectedAccountIds: string[];
  scheduledAt: string | null;
  scheduleEnabled: boolean;
  scheduleTimezone: string;
  uploadMethod: "local" | "url" | "text";
  // Store file metadata for persistence (not the actual files)
  fileMetadata: Array<{
    id: string;
    previewUrl: string;
    fileType: "image" | "video" | "gif";
    storagePath?: string;
    uploaded?: boolean;
    cloudinaryUrl?: string;
    cloudinaryPublicId?: string;
    fromMediaLibrary?: boolean;
    altText?: string;
    mediaSource?: "klipy" | "pexels" | "pixabay" | "giphy" | "unsplash" | "local";
    photographerName?: string;
    photographerUrl?: string;
    unsplashUrl?: string;
  }>;
  savedAt: number;
}

// Helper to load initial draft state synchronously
const getInitialDraftState = () => {
  const savedDraft = sessionStorage.getItem(POST_DRAFT_KEY);
  if (savedDraft) {
    try {
      const draft: PostDraftState = JSON.parse(savedDraft);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      if (Date.now() - draft.savedAt < maxAge) {
        return draft;
      }
      sessionStorage.removeItem(POST_DRAFT_KEY);
    } catch (e) {
      console.error("Failed to parse post draft:", e);
      sessionStorage.removeItem(POST_DRAFT_KEY);
    }
  }
  return null;
};

export function usePostForm() {
  const { toast } = useToast();
  const { user, profile } = useAuth();
  const { data: connectedAccounts = [], isLoading: accountsLoading } = useSocialAccounts();
  const [searchParams, setSearchParams] = useSearchParams();

  // Load draft synchronously during initial render to avoid hook ordering issues
  const initialDraft = useMemo(() => getInitialDraftState(), []);
  const draftNotifiedRef = useRef(false);
  const lastDraftWriteRef = useRef<string | null>(null);

  // Core form state - initialize from draft if available
  const [caption, setCaptionState] = useState(() => initialDraft?.caption || "");
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(() => initialDraft?.selectedAccountIds || []);
  const [files, setFilesState] = useState<UploadedFile[]>(() => {
    if (initialDraft?.fileMetadata && initialDraft.fileMetadata.length > 0) {
      return initialDraft.fileMetadata.map(meta => {
        const uploaded = Boolean(meta.storagePath) && meta.uploaded !== false;
        return {
          id: meta.id,
          file: new File([], "restored-file"),
          previewUrl: meta.cloudinaryUrl || meta.previewUrl,
          fileType: meta.fileType,
          uploadProgress: uploaded ? 100 : 0,
          uploaded,
          uploadError: uploaded ? undefined : "Remove this incomplete media item and select the file again before publishing.",
          storagePath: uploaded ? meta.storagePath : undefined,
          cloudinaryUrl: uploaded ? meta.cloudinaryUrl : undefined,
          cloudinaryPublicId: uploaded ? meta.cloudinaryPublicId : undefined,
          fromMediaLibrary: meta.fromMediaLibrary,
          altText: meta.altText,
          mediaSource: meta.mediaSource,
          photographerName: meta.photographerName,
          photographerUrl: meta.photographerUrl,
          unsplashUrl: meta.unsplashUrl,
        };
      });
    }
    return [];
  });
  const [isPosting, setIsPostingState] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(() =>
    initialDraft?.scheduledAt ? new Date(initialDraft.scheduledAt) : null
  );
  const [scheduleEnabled, setScheduleEnabled] = useState(() => initialDraft?.scheduleEnabled || false);
  const [scheduleTimezone, setScheduleTimezone] = useState(() => initialDraft?.scheduleTimezone || "");
  const [uploadMethod, setUploadMethod] = useState<"local" | "url" | "text">(() => initialDraft?.uploadMethod || "local");
  const [mediaValidation, setMediaValidation] = useState<ValidationResult | null>(null);

  // Platform filter and account ordering
  const [platformFilter, setPlatformFilter] = useState<Platform[]>([]);
  const [accountOrder, setAccountOrder] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(true);
  const isPostingRef = useRef(false);
  const composerGenerationRef = useRef(0);
  const filesRef = useRef(files);

  const setIsPosting = useCallback((posting: boolean) => {
    isPostingRef.current = posting;
    if (activeRef.current) setIsPostingState(posting);
  }, []);

  const setFiles = useCallback<React.Dispatch<React.SetStateAction<UploadedFile[]>>>((update) => {
    if (activeRef.current && !isPostingRef.current) setFilesState(update);
  }, []);

  const setCaption = useCallback<React.Dispatch<React.SetStateAction<string>>>((update) => {
    if (activeRef.current && !isPostingRef.current) setCaptionState(update);
  }, []);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      composerGenerationRef.current += 1;
      for (const file of filesRef.current) {
        if (file.previewUrl.startsWith("blob:")) URL.revokeObjectURL(file.previewUrl);
      }
    };
  }, []);

  // Show draft restored notification once after mount
  useEffect(() => {
    if (initialDraft && !draftNotifiedRef.current) {
      draftNotifiedRef.current = true;
      toast({
        title: "Draft restored",
        description: "Your previous post draft has been loaded.",
      });
    }
  }, [initialDraft, toast]);

  // Save draft to sessionStorage whenever form state changes
  useEffect(() => {
    if (!caption && files.length === 0 && selectedAccountIds.length === 0) {
      sessionStorage.removeItem(POST_DRAFT_KEY);
      lastDraftWriteRef.current = null;
      return;
    }

    const draft: PostDraftState = {
      draftVersion: crypto.randomUUID(),
      caption,
      selectedAccountIds,
      scheduledAt: scheduledAt?.toISOString() || null,
      scheduleEnabled,
      scheduleTimezone,
      uploadMethod,
      fileMetadata: files.map(f => ({
        id: f.id,
        uploaded: f.uploaded,
        previewUrl: f.cloudinaryUrl || f.previewUrl,
        fileType: f.fileType,
        storagePath: f.storagePath,
        cloudinaryUrl: f.cloudinaryUrl,
        cloudinaryPublicId: f.cloudinaryPublicId,
        fromMediaLibrary: f.fromMediaLibrary,
        altText: f.altText,
        mediaSource: f.mediaSource,
        photographerName: f.photographerName,
        photographerUrl: f.photographerUrl,
        unsplashUrl: f.unsplashUrl,
      })),
      savedAt: Date.now(),
    };

    const serializedDraft = JSON.stringify(draft);
    sessionStorage.setItem(POST_DRAFT_KEY, serializedDraft);
    lastDraftWriteRef.current = serializedDraft;
  }, [caption, selectedAccountIds, scheduledAt, scheduleEnabled, scheduleTimezone, uploadMethod, files]);

  // Check for reuse post payload on mount
  useEffect(() => {
    const fromReuse = searchParams.get("from") === "reuse";
    if (fromReuse) {
      const storedData = sessionStorage.getItem("postora_reuse_payload");
      if (storedData) {
        try {
          const payload = JSON.parse(storedData);
          if (payload.caption && (payload.mode === "caption" || payload.mode === "full")) {
            setCaptionState(payload.caption);
          }
          if (payload.media && Array.isArray(payload.media) && (payload.mode === "media" || payload.mode === "full")) {
            const reuseFiles: UploadedFile[] = payload.media.map((m: { id: string; url: string; kind?: string }, i: number) => ({
              id: `reuse-${m.id}-${Date.now()}-${i}`,
              file: new File([], "reused-file"),
              previewUrl: m.url,
              fileType: m.kind === "video" ? "video" : "image",
              uploadProgress: 100,
              uploaded: true,
              storagePath: m.id,
              cloudinaryUrl: m.url,
              fromMediaLibrary: true,
            }));
            setFilesState(reuseFiles);
          }
          sessionStorage.removeItem("postora_reuse_payload");
          searchParams.delete("from");
          setSearchParams(searchParams, { replace: true });
        } catch (e) {
          console.error("Failed to parse reuse payload:", e);
          sessionStorage.removeItem("postora_reuse_payload");
        }
      }
    }
  }, []);

  // Check for media library selection on mount
  useEffect(() => {
    const fromMediaLibrary = searchParams.get("from") === "media-library";
    if (fromMediaLibrary) {
      const storedData = sessionStorage.getItem("mediaLibrarySelection");
      if (storedData) {
        try {
          const mediaSelections: MediaLibrarySelection[] = JSON.parse(storedData);

          const libraryFiles: UploadedFile[] = mediaSelections.map((media, index) => ({
            id: `library-${media.id}-${Date.now()}-${index}`,
            file: new File([], media.fileName),
            previewUrl: media.url,
            fileType: media.fileType,
            uploadProgress: 100,
            uploaded: true,
            storagePath: media.id,
            cloudinaryUrl: media.url,
            cloudinaryPublicId: media.cloudinaryPublicId,
            fromMediaLibrary: true,
          }));

          setFilesState(libraryFiles);

          toast({
            title: "Media loaded",
            description: `${libraryFiles.length} file(s) loaded from Media Library`,
          });

          sessionStorage.removeItem("mediaLibrarySelection");
          searchParams.delete("from");
          setSearchParams(searchParams, { replace: true });
        } catch (e) {
          console.error("Failed to parse media library selection:", e);
        }
      }
    }
  }, []);

  // ---- Edit scheduled post mode ----
  const editPostId = searchParams.get("edit");
  const [isLoadingEditPost, setIsLoadingEditPost] = useState(Boolean(editPostId));
  const [editStatus, setEditStatus] = useState<"idle" | "loading" | "ready" | "error">(editPostId ? "loading" : "idle");
  const [editMetadata, setEditMetadata] = useState<Record<string, unknown> | null>(null);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const [editReloadNonce, setEditReloadNonce] = useState(0);
  const editRequestRef = useRef(0);
  const editContextRef = useRef({ preferredTimezone: profile?.preferred_timezone, toast });
  useLayoutEffect(() => {
    editContextRef.current = { preferredTimezone: profile?.preferred_timezone, toast };
  }, [profile?.preferred_timezone, toast]);

  useEffect(() => {
    if (!editPostId) {
      setEditStatus("idle");
      setEditLoadError(null);
      setIsLoadingEditPost(false);
      return;
    }

    const requestId = ++editRequestRef.current;
    setEditStatus("loading");
    setEditLoadError(null);
    setIsLoadingEditPost(true);

    const loadEditPost = async () => {
      try {
        const { data: post, error } = await supabase
          .from("posts")
          .select("*")
          .eq("id", editPostId)
          .single();

        if (error || !post) throw new Error("Could not load the scheduled post.");

        const mediaIds = Array.isArray(post.media_file_ids) ? post.media_file_ids : [];
        let editFiles: UploadedFile[] = [];
        if (mediaIds.length > 0) {
          const { data: mediaFiles, error: mediaReadError } = await supabase
            .from("media_files")
            .select("*")
            .in("id", mediaIds);
          if (mediaReadError) throw new Error("Could not read this post's media. No changes were loaded.");
          const missingIds = getMissingMediaFileIds(mediaIds, mediaFiles ?? []);
          if (missingIds.length > 0) {
            throw new Error(`${missingIds.length} media item(s) are missing. Saving is blocked so they are not removed accidentally.`);
          }

          editFiles = orderPostMediaFiles(mediaIds, mediaFiles ?? []).map((mf, index) => {
            const url = resolveMediaPublicUrl(mf, (bucket, path) =>
              supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || path,
            );
            return {
              id: `edit-${editPostId}-${index}-${mf.id}`,
              file: new File([], mf.file_path?.split("/").pop() || "media-file"),
              previewUrl: url,
              fileType: (mf.file_type === "video" ? "video" : "image") as "image" | "video" | "gif",
              uploadProgress: 100,
              uploaded: true,
              storagePath: mf.id,
              cloudinaryUrl: url,
              cloudinaryPublicId: mf.cloudinary_public_id || undefined,
              fromMediaLibrary: true,
            };
          });
        }

        if (!activeRef.current || editRequestRef.current !== requestId) return;
        const meta = post.metadata as { schedule_timezone?: string; timezone?: string; selected_account_ids?: string[] } | null;
        setEditMetadata((post.metadata ?? {}) as Record<string, unknown>);
        const accountIds = Array.isArray(meta?.selected_account_ids) ? meta.selected_account_ids : [];
        setCaptionState(post.caption ?? "");
        setScheduledAt(post.scheduled_at ? new Date(post.scheduled_at) : null);
        setScheduleEnabled(Boolean(post.scheduled_at));
        setScheduleTimezone(meta?.schedule_timezone || meta?.timezone || editContextRef.current.preferredTimezone || "");
        setSelectedAccountIds(accountIds);
        setFilesState(editFiles);
        setMediaValidation(null);
        setEditStatus("ready");
        editContextRef.current.toast({ title: "Post loaded", description: "Edit the scheduled post and save changes." });
      } catch (err) {
        if (!activeRef.current || editRequestRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : "Failed to load post for editing.";
        console.error("Error loading edit post:", err);
        setEditStatus("error");
        setEditLoadError(message);
        editContextRef.current.toast({ title: "Error", description: message, variant: "destructive" });
      } finally {
        if (activeRef.current && editRequestRef.current === requestId) setIsLoadingEditPost(false);
      }
    };

    loadEditPost();
    return () => {
      if (editRequestRef.current === requestId) editRequestRef.current += 1;
    };
  }, [editPostId, editReloadNonce]);

  // Load preferred timezone from profile on mount
  useEffect(() => {
    // A late preference must not replace the draft version captured for submission.
    if (!isPosting && profile?.preferred_timezone && !scheduleTimezone) {
      setScheduleTimezone(profile.preferred_timezone);
    }
  }, [profile?.preferred_timezone, scheduleTimezone, isPosting]);

  // Create account entries with full account info
  const availableAccounts = useMemo(() =>
    connectedAccounts.map((acc) => ({
      id: acc.id,
      platform: acc.platform,
      maxChars: platformCharLimits[acc.platform],
      username: acc.platform_username,
      avatarUrl: acc.avatar_url,
      tokenExpired: !!acc.needs_reauth,
    })),
    [connectedAccounts]
  );

  // Group accounts by platform
  const accountsByPlatform = useMemo(() =>
    availableAccounts.reduce((acc, account) => {
      if (!acc[account.platform]) {
        acc[account.platform] = [];
      }
      acc[account.platform].push(account);
      return acc;
    }, {} as Record<Platform, typeof availableAccounts>),
    [availableAccounts]
  );

  // Get unique platforms from connected accounts
  const allPlatforms = useMemo(() =>
    [...new Set(availableAccounts.map(acc => acc.platform))] as Platform[],
    [availableAccounts]
  );

  // Filter accounts by platform filter
  const filteredAccountsByPlatform = useMemo(() => {
    if (platformFilter.length === 0) return accountsByPlatform;
    return Object.fromEntries(
      Object.entries(accountsByPlatform).filter(([platform]) =>
        platformFilter.includes(platform as Platform)
      )
    ) as Record<Platform, typeof availableAccounts>;
  }, [accountsByPlatform, platformFilter]);

  // Derive unique selected platforms from selected accounts
  const selectedPlatformsFromAccounts = useMemo(() => [...new Set(
    connectedAccounts
      .filter(acc => selectedAccountIds.includes(acc.id))
      .map(acc => acc.platform)
  )], [connectedAccounts, selectedAccountIds]);

  useEffect(() => {
    setSelectedPlatforms((currentPlatforms) => {
      const unchanged = currentPlatforms.length === selectedPlatformsFromAccounts.length
        && currentPlatforms.every((platform, index) => platform === selectedPlatformsFromAccounts[index]);
      return unchanged ? currentPlatforms : selectedPlatformsFromAccounts;
    });
  }, [selectedPlatformsFromAccounts]);

  // Media state checks
  const hasOnlyImages = useMemo(() => {
    if (files.length === 0) return false;
    return files.every(f => f.fileType === "image");
  }, [files]);

  const hasVideo = useMemo(() => {
    return files.some(f => f.fileType === "video");
  }, [files]);

  // NEW: Comprehensive media analysis
  const mediaAnalysis = useMemo<MediaAnalysis>(() => analyzeMedia(files), [files]);

  // NEW: Platform eligibility based on media analysis
  const platformEligibility = useMemo<PlatformEligibility[]>(() => {
    return getAllPlatformEligibility(mediaAnalysis, allPlatforms);
  }, [mediaAnalysis, allPlatforms]);

  // NEW: Get list of eligible platforms
  const eligiblePlatforms = useMemo<Platform[]>(() => {
    return platformEligibility
      .filter(e => e.isEligible)
      .map(e => e.platform);
  }, [platformEligibility]);

  // Filter out media-required platforms when in text-only mode
  const availablePlatformsForUploadMethod = useMemo(() => {
    if (uploadMethod === "text") {
      return allPlatforms.filter(p => !MEDIA_REQUIRED_PLATFORMS.includes(p));
    }
    return allPlatforms;
  }, [allPlatforms, uploadMethod]);

  // NEW: Filter accountsByPlatform based on media eligibility
  const filteredAccountsForUploadMethod = useMemo(() => {
    // First apply text-only mode filter
    let filtered = filteredAccountsByPlatform;
    if (uploadMethod === "text") {
      filtered = Object.fromEntries(
        Object.entries(filtered).filter(
          ([platform]) => !MEDIA_REQUIRED_PLATFORMS.includes(platform as Platform)
        )
      ) as Record<Platform, typeof availableAccounts>;
    }

    // Then filter by media eligibility (for local/url uploads with media)
    if (uploadMethod !== "text" && files.length > 0) {
      filtered = Object.fromEntries(
        Object.entries(filtered).filter(
          ([platform]) => eligiblePlatforms.includes(platform as Platform)
        )
      ) as Record<Platform, typeof availableAccounts>;
    }

    return filtered;
  }, [filteredAccountsByPlatform, uploadMethod, files.length, eligiblePlatforms]);

  const hasCharacterError = useMemo(() =>
    selectedPlatforms.some((platform) => caption.length > platformCharLimits[platform]),
    [selectedPlatforms, caption]
  );

  // TikTok account IDs to auto-deselect
  const tiktokAccountIds = useMemo(() =>
    connectedAccounts.filter(acc => acc.platform === "tiktok").map(acc => acc.id),
    [connectedAccounts]
  );

  // NEW: Auto-deselect accounts when they become ineligible due to media changes
  const prevEligiblePlatformsRef = useRef<Platform[]>(eligiblePlatforms);
  useEffect(() => {
    // Skip if no files or first render
    if (files.length === 0) {
      prevEligiblePlatformsRef.current = eligiblePlatforms;
      return;
    }

    // Check if eligibility changed
    const prevEligible = prevEligiblePlatformsRef.current;
    const newlyIneligible = prevEligible.filter(p => !eligiblePlatforms.includes(p));

    if (newlyIneligible.length > 0 && selectedAccountIds.length > 0) {
      // Find accounts that are now ineligible
      const accountsToRemove = selectedAccountIds.filter(id => {
        const account = connectedAccounts.find(a => a.id === id);
        return account && newlyIneligible.includes(account.platform);
      });

      if (accountsToRemove.length > 0) {
        setSelectedAccountIds(prev => prev.filter(id => !accountsToRemove.includes(id)));

        // Also update selected platforms
        const platformsToRemove = newlyIneligible.filter(p =>
          !selectedAccountIds.some(id => {
            const acc = connectedAccounts.find(a => a.id === id);
            return acc?.platform === p && !accountsToRemove.includes(id);
          })
        );

        if (platformsToRemove.length > 0) {
          setSelectedPlatforms(prev => prev.filter(p => !platformsToRemove.includes(p)));
        }

        toast({
          title: "Accounts auto-adjusted",
          description: `${accountsToRemove.length} account(s) were deselected because they don't support your current media selection.`,
        });
      }
    }

    prevEligiblePlatformsRef.current = eligiblePlatforms;
  }, [eligiblePlatforms, files.length]);

  // Toast helpers
  const showSuccessToast = (title: string, description: string) => {
    toast({ title, description });
  };

  const showErrorToast = (title: string, error: unknown) => {
    toast({
      title,
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    });
  };

  const showWarningToast = (title: string, description: string) => {
    toast({ title, description, variant: "destructive" });
  };

  const uploadLimits = useMediaUploadLimits();

  const setUploadProgress = (fileId: string, uploadProgress: number, generation: number) => {
    if (!activeRef.current || composerGenerationRef.current !== generation) return;
    setFilesState((prev) => prev.map((f) => (f.id === fileId ? { ...f, uploadProgress } : f)));
  };

  // Update file with Cloudinary URL and database ID.
  // IMPORTANT: also switch previewUrl to the stable Cloudinary https: URL and
  // revoke the orphaned blob: URL created at selection time. The blob: URL is
  // (a) blocked by the CSP img-src/media-src policy in production and
  // (b) a temporary handle that should not outlive upload. Without this, the
  // live preview keeps pointing at the dead blob: URL and only shows correctly
  // after a page refresh, when the draft-restore path sets previewUrl from
  // cloudinaryUrl.
  const markUploaded = (uploadFile: UploadedFile, data: { url: string; mediaFileId?: string; publicId?: string }, generation: number) => {
    if (!activeRef.current || composerGenerationRef.current !== generation) return;
    const secureUrl: string = data.url;
    setFilesState((prev) =>
      prev.map((f) => {
        if (f.id !== uploadFile.id) return f;
        const prevPreview = f.previewUrl;
        if (
          typeof prevPreview === "string" &&
          prevPreview.startsWith("blob:") &&
          prevPreview !== secureUrl
        ) {
          try { URL.revokeObjectURL(prevPreview); } catch { /* ignore */ }
        }
        return {
          ...f,
          uploadProgress: 100,
          uploaded: true,
          storagePath: data.mediaFileId, // Database UUID for media_file_ids
          cloudinaryUrl: secureUrl,
          cloudinaryPublicId: data.publicId,
          previewUrl: secureUrl, // Live preview now uses the stable https URL
        };
      })
    );
  };

  // File upload handler - uploads to Cloudinary
  const uploadFileToStorage = async (uploadFile: UploadedFile, expectedGeneration = composerGenerationRef.current) => {
    const generation = expectedGeneration;
    if (!user || !activeRef.current || isPostingRef.current) return;

    try {
      const kind = mediaTypeForFileName(uploadFile.file.name)?.kind
        ?? (uploadFile.fileType === "video" ? "video" : "image");
      const limit = maxUploadBytesFor(kind, uploadLimits);
      if (uploadFile.file.size > limit) {
        throw new Error(`${uploadFile.file.name} is over the ${formatUploadLimit(limit)} limit`);
      }

      // Over 10 MB the file goes straight to the storage provider; the edge
      // function only signs the upload and records it.
      if (needsDirectUpload(kind, uploadFile.file.size, uploadLimits)) {
        setUploadProgress(uploadFile.id, 5, generation);
        const data = await uploadLargeMedia(uploadFile.file, (percent) =>
          setUploadProgress(uploadFile.id, Math.max(5, Math.round(percent * 0.95)), generation),
        );
        markUploaded(uploadFile, data, generation);
        return;
      }

      setUploadProgress(uploadFile.id, 10, generation);

      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(uploadFile.file);
      });

      setUploadProgress(uploadFile.id, 30, generation);

      // Upload to Cloudinary via edge function
      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: {
          fileData: base64,
          fileName: uploadFile.file.name,
          fileType: uploadFile.fileType,
        },
      });

      if (error) {
        // Try to extract the real error message from the edge function response
        let errorMessage = "Upload failed";
        try {
          if (error.context) {
            const errorBody = await error.context.json();
            errorMessage = errorBody?.error || errorBody?.message || errorMessage;
          } else if (error.message) {
            errorMessage = error.message;
          }
        } catch {
          errorMessage = error.message || errorMessage;
        }
        throw new Error(errorMessage);
      }
      if (!data?.success) throw new Error(data?.error || "Upload failed");

      setUploadProgress(uploadFile.id, 90, generation);
      markUploaded(uploadFile, data, generation);
      console.log(`File uploaded to Cloudinary: ${data.url}, DB ID: ${data.mediaFileId}`);

    } catch (error) {
      if (!activeRef.current || composerGenerationRef.current !== generation) return;
      console.error("Upload error:", error);
      showErrorToast("Upload failed", error);
      setFilesState((prev) => prev.map((file) => file.id === uploadFile.id ? {
        ...file,
        uploaded: false,
        uploadError: error instanceof Error ? error.message : "Upload failed. Remove this item and select the file again.",
      } : file));
    }
  };

  // Upload external URL to Cloudinary and database
  const uploadUrlToStorage = async (url: string, fileType: "image" | "video" | "gif") => {
    if (!user) throw new Error("Please log in before uploading media.");
    const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
      body: {
        externalUrl: url,
        fileName: url.split("/").pop() || `external-${Date.now()}`,
        fileType,
      },
    });

    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || "Upload failed");
    if (!data.mediaFileId) throw new Error("The upload finished without a media ID. The post was not saved.");

    return {
      id: data.mediaFileId as string,
      url: data.url as string,
      publicId: data.publicId as string,
    };
  };

  // Handle file selection - optimized with parallel uploads
  const handleFileSelect = async (fileList: FileList | null) => {
    if (!fileList || !user || isPostingRef.current) return;
    const generation = composerGenerationRef.current;

    const filesToProcess = Array.from(fileList).slice(0, 10 - files.length);
    if (filesToProcess.length === 0) return;

    setIsUploading(true);
    const newFiles: UploadedFile[] = [];

    // Process files in parallel for validation and compression
    const processedFiles = await Promise.all(
      filesToProcess.map(async (originalFile, i) => {
        let file = originalFile;

        // Validate media for selected platforms
        if (selectedPlatforms.length > 0) {
          const validation = await validateMediaForPlatformsAsync(file, selectedPlatforms);
          if (!validation.valid) {
            toast({
              title: "Media validation failed",
              description: validation.errors[0],
              variant: "destructive",
            });
            return null;
          }
        }

        const isGif =
          file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");

        // Compress images if they're large - but NEVER compress GIFs (would convert to JPEG and break GIF support)
        if (!isGif && file.type.startsWith("image") && file.size > 1.5 * 1024 * 1024) {
          try {
            const targetQuality = file.size > 5 * 1024 * 1024 ? 0.75 : 0.85;
            const maxDim = file.size > 10 * 1024 * 1024 ? 1920 : 2048;
            const compressed = await compressImage(file, targetQuality, maxDim, maxDim);
            file = compressed;
            toast({
              title: "Image optimized",
              description: `Compressed from ${(originalFile.size / 1024 / 1024).toFixed(1)}MB to ${(file.size / 1024 / 1024).toFixed(1)}MB`,
            });
          } catch (err) {
            console.error("Compression failed:", err);
          }
        }

        // Check platform-specific file size limits
        if (selectedPlatforms.length > 0) {
          const fileType = file.type.startsWith("image") ? ("image" as const) : ("video" as const);
          const sizeCheck = checkFileSizeForPlatforms(file.size, fileType, selectedPlatforms);
          if (!sizeCheck.valid) {
            toast({
              title: "File size warning",
              description: sizeCheck.warnings[0],
              variant: "destructive",
            });
          }
        }

        const uploadedFileType: UploadedFile["fileType"] = isGif
          ? "gif"
          : file.type.startsWith("image")
            ? "image"
            : "video";

        if (import.meta.env.DEV) {
          console.log("[usePostForm] selected file:", {
            name: file.name,
            mime: file.type,
            isGif,
            uploadedFileType,
            size: file.size,
          });
        }

        return {
          id: `${Date.now()}-${i}-${Math.random().toString(36).substring(7)}`,
          file,
          previewUrl: URL.createObjectURL(file),
          fileType: uploadedFileType,
          uploadProgress: 0,
          uploaded: false,
        } as UploadedFile;
      })
    );

    const validFiles = processedFiles.filter((f): f is UploadedFile => f !== null);
    if (!activeRef.current || composerGenerationRef.current !== generation) {
      for (const file of validFiles) URL.revokeObjectURL(file.previewUrl);
      return;
    }

    if (validFiles.length === 0) {
      setIsUploading(false);
      return;
    }

    // Add files to state immediately for preview
    setFilesState((prev) => [...prev, ...validFiles].slice(0, 10));

    // Upload all files in parallel (max 3 concurrent)
    const uploadQueue = [...validFiles];
    const concurrentLimit = 3;
    const uploadPromises: Promise<void>[] = [];

    const uploadNext = async () => {
      while (uploadQueue.length > 0) {
        const file = uploadQueue.shift();
        if (file) await uploadFileToStorage(file, generation);
      }
    };

    for (let i = 0; i < Math.min(concurrentLimit, validFiles.length); i++) {
      uploadPromises.push(uploadNext());
    }

    await Promise.all(uploadPromises);
    if (activeRef.current && composerGenerationRef.current === generation) setIsUploading(false);
  };

  // Handle drag events
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  // Remove file
  const removeFile = async (id: string) => {
    if (isPostingRef.current) return;
    setFilesState((prev) => {
      const file = prev.find((candidate) => candidate.id === id);
      if (file?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(file.previewUrl);
      return prev.filter((candidate) => candidate.id !== id);
    });
  };

  // Update platform selection based on account selection
  const updatePlatformSelection = (
    isAdding: boolean,
    platform: Platform,
    accountId: string,
    currentSelectedAccountIds: string[]
  ) => {
    if (isAdding) {
      setSelectedPlatforms((prev) =>
        prev.includes(platform) ? prev : [...prev, platform]
      );
    } else {
      const otherAccountsOfPlatform = connectedAccounts.filter(
        acc => acc.platform === platform && acc.id !== accountId
      );
      const anyOtherSelected = otherAccountsOfPlatform.some(
        acc => currentSelectedAccountIds.includes(acc.id)
      );
      if (!anyOtherSelected) {
        setSelectedPlatforms((prev) => prev.filter((p) => p !== platform));
      }
    }
  };

  // Toggle platform filter
  const handlePlatformFilterToggle = (platform: Platform) => {
    setPlatformFilter(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    );
  };

  // Clear draft (e.g., after successful post)
  // Capture the submitted version so later completion cannot delete a newer write.
  const captureDraftCleanup = () => {
    const submittedSnapshot = lastDraftWriteRef.current;
    return () => {
      if (submittedSnapshot !== null && sessionStorage.getItem(POST_DRAFT_KEY) === submittedSnapshot) {
        sessionStorage.removeItem(POST_DRAFT_KEY);
      }
    };
  };

  // Validate post
  const validatePost = (unsplashValidationError?: string | null): boolean => {
    if (editPostId && editStatus !== "ready") {
      showErrorToast("Post not ready", editLoadError || "Wait for the complete post to load before saving.");
      return false;
    }

    if (!user) {
      showErrorToast("Not authenticated", "Please log in to create posts.");
      return false;
    }

    if (selectedAccountIds.length === 0) {
      showErrorToast("No accounts selected", "Please select at least one account to post to.");
      return false;
    }

    if (!caption.trim() && files.length === 0) {
      showErrorToast("Empty post", "Please add a caption or media to your post.");
      return false;
    }

    if (hasCharacterError) {
      showErrorToast("Caption too long", "Your caption exceeds the character limit for one or more platforms.");
      return false;
    }

    const pendingUploads = files.filter((f) => !f.uploaded);
    if (pendingUploads.length > 0) {
      showErrorToast("Uploads in progress", "Please wait for all files to finish uploading or select incomplete media again.");
      return false;
    }

    if (files.some((file) => !file.storagePath)) {
      showErrorToast("Media not ready", "Every selected media item needs a saved media ID. Re-upload incomplete items; the post was not saved.");
      return false;
    }

    // Validate Unsplash attribution if required
    if (unsplashValidationError) {
      showErrorToast("Attribution required", unsplashValidationError);
      return false;
    }

    return true;
  };

  return {
    // State
    caption,
    setCaption,
    selectedPlatforms,
    setSelectedPlatforms,
    selectedAccountIds,
    setSelectedAccountIds,
    files,
    setFiles,
    isPosting,
    setIsPosting,
    isUploading,
    setIsUploading,
    isDragging,
    scheduledAt,
    setScheduledAt,
    scheduleEnabled,
    setScheduleEnabled,
    scheduleTimezone,
    setScheduleTimezone,
    uploadMethod,
    setUploadMethod,
    mediaValidation,
    platformFilter,
    setPlatformFilter,
    accountOrder,
    setAccountOrder,
    fileInputRef,

    // Computed
    availableAccounts,
    accountsByPlatform,
    allPlatforms,
    filteredAccountsByPlatform,
    selectedPlatformsFromAccounts,
    hasOnlyImages,
    hasVideo,
    availablePlatformsForUploadMethod,
    filteredAccountsForUploadMethod,
    hasCharacterError,
    tiktokAccountIds,
    accountsLoading,
    connectedAccounts,
    user,
    profile,

    // NEW: Media analysis and eligibility
    mediaAnalysis,
    platformEligibility,
    eligiblePlatforms,

    // Edit mode
    editPostId,
    editMetadata,
    isLoadingEditPost,
    editStatus,
    editLoadError,
    retryEditPost: () => setEditReloadNonce((nonce) => nonce + 1),

    // Handlers
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeFile,
    updatePlatformSelection,
    handlePlatformFilterToggle,
    validatePost,
    uploadFileToStorage,
    showSuccessToast,
    showErrorToast,
    showWarningToast,
    captureDraftCleanup,
    uploadUrlToStorage,
  };
}
