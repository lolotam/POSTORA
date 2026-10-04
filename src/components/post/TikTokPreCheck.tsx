import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  formatFileSize,
  getVideoMetadata,
  getVideoMetadataFromUrl,
} from "@/lib/imageUtils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HardDrive,
  Info,
  Loader2,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { TikTokPreCheckDetails } from "./TikTokPreCheckDetails";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";

interface TikTokPreCheckProps {
  file: File | null;
  previewUrl?: string | null;
  mediaFileId?: string | null;
  isFileUploaded?: boolean;
  onTranscodeComplete?: (transcodedMediaFileId: string, transcodedUrl: string) => void;
  /** Max video duration from creator_info API - REQUIRED per TikTok Content Sharing Guidelines */
  maxVideoDurationSec?: number;
  className?: string;
}

export type VideoCheckId = "format" | "resolution" | "aspectRatio" | "duration" | "fileSize";

export interface VideoCheck {
  id: VideoCheckId;
  label: string;
  icon: React.ReactNode;
  status: "pending" | "checking" | "passed" | "warning" | "failed";
  message?: string;
  value?: string;
}

type PreCheckCache = {
  version: 1;
  key: string;
  createdAt: number;
  checks: Array<Pick<VideoCheck, "id" | "label" | "status" | "message" | "value">>;
};

const CACHE_PREFIX = "tiktok_precheck_v1:";

function buildSourceKey(opts: {
  file: File | null;
  previewUrl?: string | null;
  mediaFileId?: string | null;
}) {
  if (opts.mediaFileId) return `mf:${opts.mediaFileId}`;
  if (opts.file) return `file:${opts.file.name}:${opts.file.size}:${opts.file.lastModified}`;
  if (opts.previewUrl) return `url:${opts.previewUrl}`;
  return "";
}

function readCache(sourceKey: string): PreCheckCache | null {
  if (!sourceKey || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${sourceKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreCheckCache;
    if (parsed?.version !== 1 || parsed.key !== sourceKey || !Array.isArray(parsed.checks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(sourceKey: string, checks: VideoCheck[]) {
  if (!sourceKey || typeof window === "undefined") return;
  try {
    const cache: PreCheckCache = {
      version: 1,
      key: sourceKey,
      createdAt: Date.now(),
      checks: checks.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        message: c.message,
        value: c.value,
      })),
    };
    localStorage.setItem(`${CACHE_PREFIX}${sourceKey}`, JSON.stringify(cache));
  } catch {
    // ignore
  }
}

function mergeWithCachedChecksWhenMetaMissing(next: VideoCheck[], cached: VideoCheck[] | null) {
  if (!cached || cached.length === 0) return next;

  const cachedById = new Map(cached.map((c) => [c.id || c.label, c] as const));
  return next.map((c) => {
    // If our current run couldn't read metadata, keep the last known values
    const looksLikeMissingMeta =
      c.status === "warning" && (!c.value || c.value === "Unknown");

    if (!looksLikeMissingMeta) return c;

    const prev = cachedById.get(c.id || c.label);
    if (!prev) return c;

    // Only override if the cached value is more informative than the current placeholder
    const prevHasInfo = Boolean(prev.value && prev.value !== "Unknown");
    if (!prevHasInfo) return c;

    return {
      ...c,
      status: prev.status,
      value: prev.value,
      message: prev.message,
    };
  });
}

// Default TikTok requirements (used as fallback if creator_info not available)
const DEFAULT_TIKTOK_REQUIREMENTS = {
  minWidth: 540,
  minHeight: 960,
  recommendedWidth: 720,
  recommendedHeight: 1280,
  maxDuration: 600, // Default 10 minutes, but should use max_video_post_duration_sec from creator_info
  minFileSize: 500 * 1024,
  maxFileSize: 4 * 1024 * 1024 * 1024,
  supportedFormats: ["video/mp4", "video/quicktime"],
  aspectRatio: 9 / 16,
  aspectRatioTolerance: 0.1,
};

async function tryGetRemoteSizeBytes(url: string): Promise<number | null> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) return null;
    const len = head.headers.get("content-length");
    if (!len) return null;
    const parsed = Number(len);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function TikTokPreCheck({
  file,
  previewUrl,
  mediaFileId,
  isFileUploaded,
  onTranscodeComplete,
  maxVideoDurationSec,
  className,
}: TikTokPreCheckProps) {
  const { t } = useTranslation("postpreview");
  const { toast } = useToast();
  const { flags } = useFeatureFlags();

  // REQUIRED: Use max_video_post_duration_sec from creator_info API per TikTok Content Sharing Guidelines
  const TIKTOK_REQUIREMENTS = useMemo(
    () => ({
      ...DEFAULT_TIKTOK_REQUIREMENTS,
      maxDuration: maxVideoDurationSec || DEFAULT_TIKTOK_REQUIREMENTS.maxDuration,
    }),
    [maxVideoDurationSec]
  );

  const sourceKey = useMemo(
    () => buildSourceKey({ file, previewUrl: previewUrl || null, mediaFileId: mediaFileId || null }),
    [file, previewUrl, mediaFileId]
  );
  const cachedChecksRef = useRef<VideoCheck[] | null>(null);

  const [checks, setChecks] = useState<VideoCheck[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isTranscoding, setIsTranscoding] = useState(false);
  const [transcodeProgress, setTranscodeProgress] = useState(0);
  const [transcodeComplete, setTranscodeComplete] = useState(false);
  const [transcodedUrl, setTranscodedUrl] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [videoMetadata, setVideoMetadata] = useState<{
    width?: number;
    height?: number;
    duration?: number;
    fileSize?: number;
    format?: string;
  } | null>(null);

  // Load cached checks per-video so the evaluation stays stable across navigation.
  useEffect(() => {
    const cache = readCache(sourceKey);
    if (!cache) {
      cachedChecksRef.current = null;
      return;
    }

    const restored: VideoCheck[] = cache.checks.map((c) => {
      const id: VideoCheckId = (c.id || (
        c.label === "Format" ? "format" :
        c.label === "Resolution" ? "resolution" :
        c.label === "Aspect Ratio" ? "aspectRatio" :
        c.label === "Duration" ? "duration" :
        c.label === "File Size" ? "fileSize" : "format"
      )) as VideoCheckId;

      return {
        id,
        label: c.label,
        icon: <Video className="w-4 h-4" />,
        status: c.status,
        message: c.message,
        value: c.value,
      };
    });

    cachedChecksRef.current = restored;
    setChecks(restored);
  }, [sourceKey]);

  const localPreviewUrl = useMemo(() => {
    if (!file) return null;
    return URL.createObjectURL(file);
  }, [file]);

  useEffect(() => {
    return () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
  }, [localPreviewUrl]);

  const setInitialChecks = useCallback((): VideoCheck[] => {
    const initial: VideoCheck[] = [
      { id: "format", label: t("tikTokPreCheck.format", "Format"), icon: <Video className="w-4 h-4" />, status: "checking" },
      { id: "resolution", label: t("tikTokPreCheck.resolution", "Resolution"), icon: <Maximize2 className="w-4 h-4" />, status: "checking" },
      { id: "aspectRatio", label: t("tikTokPreCheck.aspectRatio", "Aspect Ratio"), icon: <Maximize2 className="w-4 h-4" />, status: "checking" },
      { id: "duration", label: t("tikTokPreCheck.duration", "Duration"), icon: <Clock className="w-4 h-4" />, status: "checking" },
      { id: "fileSize", label: t("tikTokPreCheck.fileSize", "File Size"), icon: <HardDrive className="w-4 h-4" />, status: "checking" },
    ];
    setChecks(initial);
    return initial;
  }, [t]);


  const runPreCheckForFile = useCallback(
    async (videoFile: File) => {
      setIsChecking(true);
      const initialChecks = setInitialChecks();

      try {
        let needsFix = false;

        // Format
        const formatCheck = { ...initialChecks[0] };
        if (TIKTOK_REQUIREMENTS.supportedFormats.includes(videoFile.type)) {
          formatCheck.status = "passed";
          formatCheck.value = videoFile.type === "video/mp4" ? "MP4" : "MOV";
          formatCheck.message = t("tikTokPreCheck.formatSupported", "Format supported");
        } else {
          formatCheck.status = "failed";
          formatCheck.value = videoFile.type || t("tikTokPreCheck.unknown", "Unknown");
          formatCheck.message = t("tikTokPreCheck.useMp4OrMov", "Use MP4 or MOV format");
          needsFix = true;
        }

        // Meta
        let meta: { width: number; height: number; duration: number } | null = null;
        try {
          meta = await getVideoMetadata(videoFile);
        } catch {
          // ignore
        }

        // Resolution
        const resolutionCheck = { ...initialChecks[1] };
        if (meta) {
          resolutionCheck.value = `${meta.width}×${meta.height}`;
          if (meta.width >= TIKTOK_REQUIREMENTS.recommendedWidth && meta.height >= TIKTOK_REQUIREMENTS.recommendedHeight) {
            resolutionCheck.status = "passed";
            resolutionCheck.message = t("tikTokPreCheck.resOptimal", "Resolution optimal");
          } else if (meta.width >= TIKTOK_REQUIREMENTS.minWidth && meta.height >= TIKTOK_REQUIREMENTS.minHeight) {
            resolutionCheck.status = "warning";
            resolutionCheck.message = t("tikTokPreCheck.resRecommended", { recommended: `${TIKTOK_REQUIREMENTS.recommendedWidth}×${TIKTOK_REQUIREMENTS.recommendedHeight}`, defaultValue: `Recommended: ${TIKTOK_REQUIREMENTS.recommendedWidth}×${TIKTOK_REQUIREMENTS.recommendedHeight}+` });
          } else {
            resolutionCheck.status = "failed";
            resolutionCheck.message = t("tikTokPreCheck.resMinimum", { minimum: `${TIKTOK_REQUIREMENTS.minWidth}×${TIKTOK_REQUIREMENTS.minHeight}`, defaultValue: `Minimum: ${TIKTOK_REQUIREMENTS.minWidth}×${TIKTOK_REQUIREMENTS.minHeight}` });
            needsFix = true;
          }
        } else {
          resolutionCheck.status = "warning";
          resolutionCheck.message = t("tikTokPreCheck.couldNotReadMeta", "Could not read video metadata");
        }

        // Aspect
        const aspectCheck = { ...initialChecks[2] };
        if (meta && meta.width > 0 && meta.height > 0) {
          const ratio = meta.width / meta.height;
          const diff = Math.abs(ratio - TIKTOK_REQUIREMENTS.aspectRatio);

          if (meta.height >= meta.width) {
            if (diff <= TIKTOK_REQUIREMENTS.aspectRatioTolerance) {
              aspectCheck.status = "passed";
              aspectCheck.value = t("tikTokPreCheck.ratioVertical", "9:16 (vertical)");
              aspectCheck.message = t("tikTokPreCheck.perfectForTikTok", "Perfect for TikTok");
            } else {
              aspectCheck.status = "warning";
              aspectCheck.value = ratio.toFixed(2);
              aspectCheck.message = t("tikTokPreCheck.closeToRatio", "Close to 9:16, may work");
            }
          } else {
            aspectCheck.status = "failed";
            aspectCheck.value = t("tikTokPreCheck.ratioHorizontal", "Horizontal");
            aspectCheck.message = t("tikTokPreCheck.requiresVertical", "TikTok requires vertical 9:16");
            needsFix = true;
          }
        } else {
          aspectCheck.status = "warning";
          aspectCheck.message = t("tikTokPreCheck.couldNotDetermineRatio", "Could not determine aspect ratio");
        }

        // Duration
        const durationCheck = { ...initialChecks[3] };
        if (meta && meta.duration > 0) {
          const mins = Math.floor(meta.duration / 60);
          const secs = Math.floor(meta.duration % 60);
          durationCheck.value = `${mins}:${secs.toString().padStart(2, "0")}`;
          if (meta.duration <= TIKTOK_REQUIREMENTS.maxDuration) {
            durationCheck.status = "passed";
            durationCheck.message = t("tikTokPreCheck.durationAcceptable", "Duration acceptable");
          } else {
            durationCheck.status = "failed";
            durationCheck.message = t("tikTokPreCheck.maxDuration", { count: TIKTOK_REQUIREMENTS.maxDuration / 60, defaultValue: `Max ${TIKTOK_REQUIREMENTS.maxDuration / 60} minutes` });
            needsFix = true;
          }
        } else {
          durationCheck.status = "warning";
          durationCheck.message = t("tikTokPreCheck.couldNotReadDuration", "Could not read duration");
        }

        // Size
        const sizeCheck = { ...initialChecks[4] };
        sizeCheck.value = formatFileSize(videoFile.size);
        if (videoFile.size < TIKTOK_REQUIREMENTS.minFileSize) {
          sizeCheck.status = "failed";
          sizeCheck.message = t("tikTokPreCheck.fileTooSmall", "File too small (likely invalid)");
          needsFix = true;
        } else if (videoFile.size > TIKTOK_REQUIREMENTS.maxFileSize) {
          sizeCheck.status = "failed";
          sizeCheck.message = t("tikTokPreCheck.fileTooLarge", "File too large (max 4GB)");
          needsFix = true;
        } else if (videoFile.size < 1024 * 1024) {
          sizeCheck.status = "warning";
          sizeCheck.message = t("tikTokPreCheck.verySmallFile", "Very small file, may be rejected");
        } else {
          sizeCheck.status = "passed";
          sizeCheck.message = t("tikTokPreCheck.fileSizeOk", "File size OK");
        }

        // If it needs fix, show transcode CTA (existing UX)
        // We'll reflect this by keeping failed checks.
        const next = [formatCheck, resolutionCheck, aspectCheck, durationCheck, sizeCheck];
        const merged = mergeWithCachedChecksWhenMetaMissing(next, cachedChecksRef.current);
        setChecks(merged);
        cachedChecksRef.current = merged;
        writeCache(sourceKey, merged);
        setLastCheckedAt(new Date());
        
        // Store video metadata for details drawer
        setVideoMetadata({
          width: meta?.width,
          height: meta?.height,
          duration: meta?.duration,
          fileSize: videoFile.size,
          format: videoFile.type === "video/mp4" ? "MP4" : videoFile.type === "video/quicktime" ? "MOV" : videoFile.type,
        });
        
        // Persist to Supabase if mediaFileId is available
        if (mediaFileId) {
          persistPreCheckToSupabase(mediaFileId, merged, meta, videoFile.size);
        }

        return { needsFix };
      } finally {
        setIsChecking(false);
      }
    },
    [TIKTOK_REQUIREMENTS, setInitialChecks, sourceKey, mediaFileId, t]
  );
  
  // Persist pre-check results to Supabase media_files.metadata
  const persistPreCheckToSupabase = useCallback(async (
    mfId: string,
    checksToSave: VideoCheck[],
    meta: { width: number; height: number; duration: number } | null,
    fileSize?: number
  ) => {
    try {
      const preCheckData = {
        tiktok_precheck: {
          checks: checksToSave.map((c) => ({
            label: c.label,
            status: c.status,
            message: c.message,
            value: c.value,
          })),
          videoMetadata: meta ? {
            width: meta.width,
            height: meta.height,
            duration: meta.duration,
            fileSize,
          } : null,
          checkedAt: new Date().toISOString(),
          version: 1,
        },
      };
      
      // Update metadata by merging with existing
      const { data: existing } = await supabase
        .from("media_files")
        .select("metadata")
        .eq("id", mfId)
        .single();
      
      const mergedMetadata = {
        ...(existing?.metadata as Record<string, unknown> || {}),
        ...preCheckData,
      };
      
      await supabase
        .from("media_files")
        .update({ metadata: mergedMetadata })
        .eq("id", mfId);
    } catch (err) {
      console.error("Failed to persist TikTok pre-check to Supabase:", err);
    }
  }, []);

  const runPreCheckForUrl = useCallback(
    async (url: string) => {
      setIsChecking(true);
      const initialChecks = setInitialChecks();

      try {
        const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

        let sizeBytes = await tryGetRemoteSizeBytes(url);
        if (sizeBytes == null) {
          await wait(250);
          sizeBytes = await tryGetRemoteSizeBytes(url);
        }

        // We always output MP4
        const formatCheck = { ...initialChecks[0], status: "passed" as const, value: "MP4", message: t("tikTokPreCheck.transcodedAsMp4", "Transcoded as MP4") };

        // Meta
        let meta: { width: number; height: number; duration: number } | null = null;
        try {
          meta = await getVideoMetadataFromUrl(url);
        } catch {
          await wait(250);
          try {
            meta = await getVideoMetadataFromUrl(url);
          } catch {
            // ignore
          }
        }

        // Resolution
        const resolutionCheck = { ...initialChecks[1] };
        if (meta) {
          resolutionCheck.value = `${meta.width}×${meta.height}`;
          if (meta.width >= TIKTOK_REQUIREMENTS.recommendedWidth && meta.height >= TIKTOK_REQUIREMENTS.recommendedHeight) {
            resolutionCheck.status = "passed";
            resolutionCheck.message = t("tikTokPreCheck.resOptimal", "Resolution optimal");
          } else {
            resolutionCheck.status = "warning";
            resolutionCheck.message = t("tikTokPreCheck.resRecommended", { recommended: `${TIKTOK_REQUIREMENTS.recommendedWidth}×${TIKTOK_REQUIREMENTS.recommendedHeight}`, defaultValue: `Recommended: ${TIKTOK_REQUIREMENTS.recommendedWidth}×${TIKTOK_REQUIREMENTS.recommendedHeight}+` });
          }
        } else {
          resolutionCheck.status = "warning";
          resolutionCheck.message = t("tikTokPreCheck.couldNotReadMeta", "Could not read video metadata");
        }

        // Aspect
        const aspectCheck = { ...initialChecks[2] };
        if (meta && meta.width > 0 && meta.height > 0) {
          const ratio = meta.width / meta.height;
          const diff = Math.abs(ratio - TIKTOK_REQUIREMENTS.aspectRatio);
          if (meta.height >= meta.width && diff <= TIKTOK_REQUIREMENTS.aspectRatioTolerance) {
            aspectCheck.status = "passed";
            aspectCheck.value = t("tikTokPreCheck.ratioVertical", "9:16 (vertical)");
            aspectCheck.message = t("tikTokPreCheck.perfectForTikTok", "Perfect for TikTok");
          } else {
            aspectCheck.status = "warning";
            aspectCheck.value = ratio.toFixed(2);
            aspectCheck.message = t("tikTokPreCheck.ratioMayBeOff", "Aspect ratio may be off");
          }
        } else {
          aspectCheck.status = "warning";
          aspectCheck.message = t("tikTokPreCheck.couldNotDetermineRatio", "Could not determine aspect ratio");
        }

        // Duration
        const durationCheck = { ...initialChecks[3] };
        if (meta && meta.duration > 0) {
          const mins = Math.floor(meta.duration / 60);
          const secs = Math.floor(meta.duration % 60);
          durationCheck.value = `${mins}:${secs.toString().padStart(2, "0")}`;
          durationCheck.status = meta.duration <= TIKTOK_REQUIREMENTS.maxDuration ? "passed" : "warning";
          durationCheck.message = meta.duration <= TIKTOK_REQUIREMENTS.maxDuration ? t("tikTokPreCheck.durationAcceptable", "Duration acceptable") : t("tikTokPreCheck.durationLooksLong", "Duration looks long");
        } else {
          durationCheck.status = "warning";
          durationCheck.message = t("tikTokPreCheck.couldNotReadDuration", "Could not read duration");
        }

        // Size
        const sizeCheck = { ...initialChecks[4] };
        if (sizeBytes != null) {
          sizeCheck.value = formatFileSize(sizeBytes);
          sizeCheck.status = "passed";
          sizeCheck.message = t("tikTokPreCheck.fileSizeOk", "File size OK");
        } else {
          sizeCheck.value = t("tikTokPreCheck.unknown", "Unknown");
          sizeCheck.status = "warning";
          sizeCheck.message = t("tikTokPreCheck.couldNotReadSize", "Could not read size");
        }

        const next = [formatCheck, resolutionCheck, aspectCheck, durationCheck, sizeCheck];
        const merged = mergeWithCachedChecksWhenMetaMissing(next, cachedChecksRef.current);
        setChecks(merged);
        cachedChecksRef.current = merged;
        writeCache(sourceKey, merged);
        setLastCheckedAt(new Date());
        
        // Store video metadata for details drawer
        setVideoMetadata({
          width: meta?.width,
          height: meta?.height,
          duration: meta?.duration,
          fileSize: sizeBytes || undefined,
          format: "MP4",
        });
        
        // Persist to Supabase if mediaFileId is available
        if (mediaFileId) {
          persistPreCheckToSupabase(mediaFileId, merged, meta, sizeBytes || undefined);
        }
      } finally {
        setIsChecking(false);
      }
    },
    [TIKTOK_REQUIREMENTS, setInitialChecks, sourceKey, mediaFileId, persistPreCheckToSupabase, t]
  );

  useEffect(() => {
    setTranscodeComplete(false);
    setTranscodedUrl(null);

    if (file) {
      runPreCheckForFile(file);
      return;
    }

    // Support URL-only videos (stock videos / media library)
    const urlToCheck = previewUrl || null;
    if (urlToCheck) {
      runPreCheckForUrl(urlToCheck);
    } else {
      setChecks([]);
    }
  }, [file, previewUrl, runPreCheckForFile, runPreCheckForUrl]);

  // Manual re-run handler
  const handleRerunCheck = useCallback(() => {
    if (file) {
      runPreCheckForFile(file);
    } else if (previewUrl) {
      runPreCheckForUrl(previewUrl);
    }
  }, [file, previewUrl, runPreCheckForFile, runPreCheckForUrl]);

  const hasFailures = checks.some((c) => c.status === "failed");
  const hasWarnings = checks.some((c) => c.status === "warning");
  const allPassed = checks.length > 0 && checks.every((c) => c.status === "passed");

  const handleTranscode = async () => {
    if (!isFileUploaded || !mediaFileId) {
      toast({
        title: t("tikTokPreCheck.uploadRequiredTitle", "Upload required"),
        description: t("tikTokPreCheck.uploadRequiredDesc", "Please wait for the video to finish uploading before transcoding."),
        variant: "destructive",
      });
      return;
    }

    setIsTranscoding(true);
    setTranscodeProgress(15);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      setTranscodeProgress(45);

      const { data: transcodeResult, error: transcodeError } = await supabase.functions.invoke(
        "transcode-video",
        {
          body: {
            media_file_id: mediaFileId,
            user_id: user.id,
            target_platform: "tiktok",
          },
        }
      );

      if (transcodeError) throw transcodeError;
      if (!transcodeResult?.success) {
        throw new Error(transcodeResult?.error || "Transcoding failed");
      }
      if (!transcodeResult?.new_media_file_id || !transcodeResult?.transcoded_url) {
        throw new Error("Transcoding succeeded but response is missing output details");
      }

      setTranscodeProgress(100);
      setTranscodeComplete(true);
      setTranscodedUrl(transcodeResult.transcoded_url);

      toast({
        title: t("tikTokPreCheck.transcodedSuccessTitle", "Video transcoded!"),
        description: t("tikTokPreCheck.transcodedSuccessDesc", "Now using the transcoded video for TikTok."),
      });

      onTranscodeComplete?.(transcodeResult.new_media_file_id, transcodeResult.transcoded_url);

      // fast re-check: metadata only
      await runPreCheckForUrl(transcodeResult.transcoded_url);
    } catch (error) {
      console.error("Transcode error:", error);
      toast({
        title: t("tikTokPreCheck.transcodeFailedTitle", "Transcode failed"),
        description: error instanceof Error ? error.message : "Failed to transcode video",
        variant: "destructive",
      });
    } finally {
      setIsTranscoding(false);
      setTranscodeProgress(0);
    }
  };

  const previewSrc = transcodedUrl || previewUrl || localPreviewUrl;

  if (!previewSrc) return null;

  return (
    <div className={cn("rounded-xl border border-border bg-card overflow-hidden", className)}>
      {/* Header with timestamp and actions */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Video className="w-4 h-4 text-primary" />
            {t("tikTokPreCheck.title", "TikTok Video Pre-Check")}
          </h4>
          {lastCheckedAt && !isChecking && (
            <span className="text-[10px] text-muted-foreground">
              • {formatDistanceToNow(lastCheckedAt, { addSuffix: true })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isChecking && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleRerunCheck}
            disabled={isChecking}
          >
            <RotateCcw className="w-3 h-3 me-1" />
            {t("tikTokPreCheck.recheck", "Re-check")}
          </Button>
          <TikTokPreCheckDetails
            checks={checks}
            videoMetadata={videoMetadata || undefined}
            lastCheckedAt={lastCheckedAt}
          >
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
              <Info className="w-3 h-3 me-1" />
              {t("tikTokPreCheck.details", "Details")}
            </Button>
          </TikTokPreCheckDetails>
        </div>
      </div>

      {/* Main content: Video on left, Checks on right */}
      <div className="flex gap-4 p-4">
        {/* Left: Video Preview (Reel size) */}
        {previewSrc && (
          <div className="shrink-0">
            <div className="w-36 aspect-[9/16] rounded-lg overflow-hidden border border-border bg-black shadow-lg">
              <video
                src={previewSrc}
                className="w-full h-full object-cover"
                muted
                playsInline
                preload="metadata"
                controls
              />
            </div>
            {transcodeComplete && (
              <div className="mt-2 flex items-center justify-center gap-1 text-xs text-emerald-600 font-medium">
                <CheckCircle2 className="w-3 h-3" />
                {t("tikTokPreCheck.transcoded", "Transcoded")}
              </div>
            )}
          </div>
        )}

        {/* Right: Checks list */}
        <div className="flex-1 min-w-0 space-y-2">
          {checks.map((check, idx) => (
            <div
              key={idx}
              className={cn(
                "flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm",
                check.status === "passed" && "bg-emerald-500/5 border-emerald-500/30",
                check.status === "warning" && "bg-amber-500/5 border-amber-500/30",
                check.status === "failed" && "bg-destructive/5 border-destructive/30",
                check.status === "checking" && "bg-muted/50 border-border",
                check.status === "pending" && "bg-muted/30 border-border"
              )}
            >
              <div className="flex items-center gap-2.5">
                {check.status === "checking" ? (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                ) : check.status === "passed" ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : check.status === "warning" ? (
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                ) : check.status === "failed" ? (
                  <AlertCircle className="w-4 h-4 text-destructive" />
                ) : (
                  check.icon
                )}
                <span className="font-medium">{check.label}</span>
                {check.value && (
                  <span className="text-muted-foreground">({check.value})</span>
                )}
              </div>
              {check.message && (
                <span
                  className={cn(
                    "text-xs font-medium",
                    check.status === "passed" && "text-emerald-600",
                    check.status === "warning" && "text-amber-600",
                    check.status === "failed" && "text-destructive"
                  )}
                >
                  {check.message}
                </span>
              )}
            </div>
          ))}

          {/* Status messages */}
          {!isChecking && checks.length > 0 && (
            <div className="pt-2">
              {(allPassed || transcodeComplete) && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-sm text-emerald-600">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    {transcodeComplete ? t("tikTokPreCheck.transcodeReadyMsg", "Transcoded video is ready for TikTok") : t("tikTokPreCheck.meetsReqsMsg", "Video meets TikTok requirements")}
                  </span>
                </div>
              )}

              {hasFailures && !transcodeComplete && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>
                      {flags.tiktokTranscode 
                        ? t("tikTokPreCheck.doesNotMeetTranscode", "Video doesn't meet TikTok requirements. Transcode to fix.")
                        : t("tikTokPreCheck.doesNotMeet", "Video doesn't meet TikTok requirements.")}
                    </span>
                  </div>

                  {flags.tiktokTranscode && (
                    <>
                      {isTranscoding ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">
                              {transcodeProgress < 45 ? t("tikTokPreCheck.preparing", "Preparing...") : transcodeProgress < 100 ? t("tikTokPreCheck.transcoding", "Transcoding...") : t("tikTokPreCheck.done", "Done")}
                            </span>
                            <span className="font-medium">{transcodeProgress}%</span>
                          </div>
                          <Progress value={transcodeProgress} className="h-2" />
                        </div>
                      ) : (
                        <Button
                          onClick={handleTranscode}
                          className="w-full"
                          variant="outline"
                          disabled={!isFileUploaded}
                        >
                          <RefreshCw className="w-4 h-4 me-2" />
                          {t("tikTokPreCheck.transcodeBtn", "Transcode for TikTok")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}

              {hasWarnings && !hasFailures && !transcodeComplete && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-600">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{t("tikTokPreCheck.warningMsg", "Video may work but isn't optimal. Consider transcoding.")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
