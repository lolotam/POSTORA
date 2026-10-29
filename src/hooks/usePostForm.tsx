import { useState, useEffect, useMemo, useRef } from "react";
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

export interface UploadedFile {
  id: string;
  file: File;
  previewUrl: string;
  fileType: "image" | "video" | "gif";
  uploadProgress: number;
  uploaded: boolean;
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

  // Core form state - initialize from draft if available
  const [caption, setCaption] = useState(() => initialDraft?.caption || "");
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(() => initialDraft?.selectedAccountIds || []);
  const [files, setFiles] = useState<UploadedFile[]>(() => {
    if (initialDraft?.fileMetadata && initialDraft.fileMetadata.length > 0) {
      return initialDraft.fileMetadata.map(meta => ({
        id: meta.id,
        file: new File([], "restored-file"),
        previewUrl: meta.cloudinaryUrl || meta.previewUrl,
        fileType: meta.fileType,
        uploadProgress: 100,
        uploaded: true,
        storagePath: meta.storagePath,
        cloudinaryUrl: meta.cloudinaryUrl,
        cloudinaryPublicId: meta.cloudinaryPublicId,
        fromMediaLibrary: meta.fromMediaLibrary,
      }));
    }
    return [];
  });
  const [isPosting, setIsPosting] = useState(false);
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
      return;
    }

    const draft: PostDraftState = {
      caption,
      selectedAccountIds,
      scheduledAt: scheduledAt?.toISOString() || null,
      scheduleEnabled,
      scheduleTimezone,
      uploadMethod,
      fileMetadata: files.filter(f => f.uploaded).map(f => ({
        id: f.id,
        previewUrl: f.cloudinaryUrl || f.previewUrl,
        fileType: f.fileType,
        storagePath: f.storagePath,
        cloudinaryUrl: f.cloudinaryUrl,
        cloudinaryPublicId: f.cloudinaryPublicId,
        fromMediaLibrary: f.fromMediaLibrary,
      })),
      savedAt: Date.now(),
    };

    sessionStorage.setItem(POST_DRAFT_KEY, JSON.stringify(draft));
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
            setCaption(payload.caption);
          }
          if (payload.media && Array.isArray(payload.media) && (payload.mode === "media" || payload.mode === "full")) {
            const reuseFiles: UploadedFile[] = payload.media.map((m: any, i: number) => ({
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
            setFiles(reuseFiles);
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

          setFiles(libraryFiles);

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
  const [isLoadingEditPost, setIsLoadingEditPost] = useState(false);

  useEffect(() => {
    if (!editPostId || connectedAccounts.length === 0) return;

    const loadEditPost = async () => {
      setIsLoadingEditPost(true);
      try {
        const { data: post, error } = await supabase
          .from("posts")
          .select("*")
          .eq("id", editPostId)
          .single();

        if (error || !post) {
          toast({ title: "Error", description: "Could not load the scheduled post.", variant: "destructive" });
          setIsLoadingEditPost(false);
          return;
        }

        // Set caption
        if (post.caption) setCaption(post.caption);

        // Set schedule
        if (post.scheduled_at) {
          setScheduledAt(new Date(post.scheduled_at));
          setScheduleEnabled(true);
        }

        // Set timezone from metadata
        const meta = post.metadata as Record<string, any> | null;
        if (meta?.timezone) setScheduleTimezone(meta.timezone);

        // Select accounts from metadata
        const accountIds = meta?.selected_account_ids as string[] | undefined;
        if (accountIds && accountIds.length > 0) {
          setSelectedAccountIds(accountIds);
        }

        // Load media files
        if (post.media_file_ids && post.media_file_ids.length > 0) {
          const { data: mediaFiles } = await supabase
            .from("media_files")
            .select("*")
            .in("id", post.media_file_ids);

          if (mediaFiles && mediaFiles.length > 0) {
            const editFiles: UploadedFile[] = mediaFiles.map((mf: any, i: number) => {
              // Resolve the public URL via the shared helper. For Cloudinary rows,
              // file_path already stores the full secure_url (cloud name + version +
              // extension); rebuilding it from storage_bucket/public_id produced
              // broken links (see resolveMediaPublicUrl docs).
              const url = resolveMediaPublicUrl(mf, (bucket, path) =>
                supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || path,
              );

              return {
                id: mf.id,
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
            setFiles(editFiles);
          }
        }

        toast({ title: "Post loaded", description: "Edit the scheduled post and save changes." });
      } catch (err) {
        console.error("Error loading edit post:", err);
        toast({ title: "Error", description: "Failed to load post for editing.", variant: "destructive" });
      } finally {
        setIsLoadingEditPost(false);
      }
    };

    loadEditPost();
  }, [editPostId, connectedAccounts.length]);

  // Load preferred timezone from profile on mount
  useEffect(() => {
    if (profile?.preferred_timezone && !scheduleTimezone) {
      setScheduleTimezone(profile.preferred_timezone);
    }
  }, [profile?.preferred_timezone]);

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

  const setUploadProgress = (fileId: string, uploadProgress: number) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, uploadProgress } : f)));
  };

  // Update file with Cloudinary URL and database ID.
  // IMPORTANT: also switch previewUrl to the stable Cloudinary https: URL and
  // revoke the orphaned blob: URL created at selection time. The blob: URL is
  // (a) blocked by the CSP img-src/media-src policy in production and
  // (b) a temporary handle that should not outlive upload. Without this, the
  // live preview keeps pointing at the dead blob: URL and only shows correctly
  // after a page refresh, when the draft-restore path sets previewUrl from
  // cloudinaryUrl.
  const markUploaded = (uploadFile: UploadedFile, data: { url: string; mediaFileId?: string; publicId?: string }) => {
    const secureUrl: string = data.url;
    setFiles((prev) =>
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
  const uploadFileToStorage = async (uploadFile: UploadedFile) => {
    if (!user) return;

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
        setUploadProgress(uploadFile.id, 5);
        const data = await uploadLargeMedia(uploadFile.file, (percent) =>
          setUploadProgress(uploadFile.id, Math.max(5, Math.round(percent * 0.95))),
        );
        markUploaded(uploadFile, data);
        return;
      }

      setUploadProgress(uploadFile.id, 10);

      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(uploadFile.file);
      });

      setUploadProgress(uploadFile.id, 30);

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

      setUploadProgress(uploadFile.id, 90);
      markUploaded(uploadFile, data);
      console.log(`File uploaded to Cloudinary: ${data.url}, DB ID: ${data.mediaFileId}`);

    } catch (error) {
      console.error("Upload error:", error);
      showErrorToast("Upload failed", error);
      setFiles((prev) => prev.filter((f) => f.id !== uploadFile.id));
    }
  };

  // Upload external URL to Cloudinary and database
  const uploadUrlToStorage = async (url: string, fileType: "image" | "video" | "gif") => {
    if (!user) return null;

    try {
      // Upload to Cloudinary via edge function (using externalUrl)
      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: {
          externalUrl: url,
          fileName: url.split("/").pop() || `external-${Date.now()}`,
          fileType: fileType,
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || "Upload failed");

      console.log(`URL uploaded to Cloudinary/DB: ${data.url}, DB ID: ${data.mediaFileId}`);

      return {
        id: data.mediaFileId as string,
        url: data.url as string,
        publicId: data.publicId as string
      };

    } catch (error) {
      console.error("URL upload error:", error);
      // Don't show toast here to avoid spamming if processing multiple
      return null;
    }
  };

  // Handle file selection - optimized with parallel uploads
  const handleFileSelect = async (fileList: FileList | null) => {
    if (!fileList || !user) return;

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
            file = new File([compressed], file.name, { type: "image/jpeg" });
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

    // Filter out nulls (failed validations)
    const validFiles = processedFiles.filter((f): f is UploadedFile => f !== null);

    if (validFiles.length === 0) {
      setIsUploading(false);
      return;
    }

    // Add files to state immediately for preview
    setFiles((prev) => [...prev, ...validFiles].slice(0, 10));

    // Upload all files in parallel (max 3 concurrent)
    const uploadQueue = [...validFiles];
    const concurrentLimit = 3;
    const uploadPromises: Promise<void>[] = [];

    const uploadNext = async () => {
      while (uploadQueue.length > 0) {
        const file = uploadQueue.shift();
        if (file) await uploadFileToStorage(file);
      }
    };

    for (let i = 0; i < Math.min(concurrentLimit, validFiles.length); i++) {
      uploadPromises.push(uploadNext());
    }

    await Promise.all(uploadPromises);
    setIsUploading(false);
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
    const file = files.find((f) => f.id === id);
    if (file) {
      URL.revokeObjectURL(file.previewUrl);
    }
    setFiles((prev) => prev.filter((f) => f.id !== id));
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

  // Reset form and clear draft
  const resetPostForm = () => {
    setCaption("");
    setFiles([]);
    setSelectedPlatforms([]);
    setSelectedAccountIds([]);
    setScheduledAt(null);
    setScheduleEnabled(false);
    sessionStorage.removeItem(POST_DRAFT_KEY);
  };

  // Clear draft (e.g., after successful post)
  const clearDraft = () => {
    sessionStorage.removeItem(POST_DRAFT_KEY);
  };

  // Validate post
  const validatePost = (unsplashValidationError?: string | null): boolean => {
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
      showErrorToast("Uploads in progress", "Please wait for all files to finish uploading.");
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
    isLoadingEditPost,

    // Handlers
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
    showWarningToast,
    clearDraft,
    uploadUrlToStorage,
  };
}
