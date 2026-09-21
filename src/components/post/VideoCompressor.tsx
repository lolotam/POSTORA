import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Minimize2, Loader2, Check, X, HardDrive, Percent, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useProcessingJobsContext } from "@/contexts/ProcessingJobsContext";
import { VideoProcessingPresetSelector } from "./VideoProcessingPresetSelector";

interface VideoCompressorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoFile: File | null;
  videoSrc: string;
  mediaFileId?: string; // Database ID for Cloudinary processing
  onCompressComplete: (compressedBlob: Blob, compressedUrl: string, newMediaFileId?: string) => void;
}

type CompressionMode = "percentage" | "targetSize";

export function VideoCompressor({
  open,
  onOpenChange,
  videoFile,
  videoSrc,
  mediaFileId,
  onCompressComplete,
}: VideoCompressorProps) {
  const { t } = useTranslation("postmedia");
  const videoRef = useRef<HTMLVideoElement>(null);

  const [mode, setMode] = useState<CompressionMode>("percentage");
  const [percentage, setPercentage] = useState([70]); // 70% quality
  const [targetSizeMB, setTargetSizeMB] = useState("");
  const [isCompressing, setIsCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoMetadata, setVideoMetadata] = useState<{
    width: number;
    height: number;
    duration: number;
  } | null>(null);
  const [estimatedSize, setEstimatedSize] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const originalSizeMB = videoFile?.size ? videoFile.size / (1024 * 1024) : 0;

  useEffect(() => {
    if (mode === "percentage") {
      setEstimatedSize((originalSizeMB * percentage[0]) / 100);
    } else if (targetSizeMB) {
      setEstimatedSize(parseFloat(targetSizeMB));
    }
  }, [mode, percentage, targetSizeMB, originalSizeMB]);

  const handleVideoLoad = () => {
    const video = videoRef.current;
    if (video) {
      setVideoMetadata({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      });
    }
  };

  const { addJob, updateJob } = useProcessingJobsContext();

  const handleCompress = async () => {
    if (!mediaFileId) {
      setError(t("compressor.mustUploadFirst", "Video must be uploaded before compression"));
      return;
    }

    const jobId = `compress-${Date.now()}`;
    
    // Add job to processing panel with retry context
    addJob({
      id: jobId,
      fileId: mediaFileId,
      fileName: videoFile?.name || "Video",
      operation: "compress",
      status: "processing",
      progress: 0,
      retryContext: {
        mediaSrc: videoSrc,
        mediaType: "video",
        mediaFileId,
        file: videoFile || undefined,
      },
    });

    setIsCompressing(true);
    setProgress(10);
    setError(null);
    updateJob(jobId, { progress: 10 });

    try {
      // Calculate quality for Cloudinary
      let quality: number;
      let maxSizeMB: number | undefined;

      if (mode === "percentage") {
        quality = percentage[0];
      } else {
        maxSizeMB = parseFloat(targetSizeMB);
        quality = Math.max(20, Math.min(100, (maxSizeMB / originalSizeMB) * 100));
      }

      setProgress(30);
      updateJob(jobId, { progress: 30 });

      // Get user session
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      setProgress(50);
      updateJob(jobId, { progress: 50 });

      // Call Cloudinary processing edge function
      const { data, error: invokeError } = await supabase.functions.invoke("process-video", {
        body: {
          media_file_id: mediaFileId,
          user_id: user.id,
          operation: "compress",
          compress: {
            quality,
            maxSizeMB,
          },
        },
      });

      if (invokeError) throw invokeError;
      if (!data.success) throw new Error(data.error || "Compression failed");

      setProgress(90);
      updateJob(jobId, { progress: 90 });

      // Fetch the compressed video to create a blob for the callback
      const response = await fetch(data.processed_url);
      const blob = await response.blob();

      setProgress(100);
      updateJob(jobId, { status: "done", progress: 100 });

      onCompressComplete(blob, data.processed_url, data.new_media_file_id);
      onOpenChange(false);
    } catch (err) {
      console.error("Compression failed:", err);
      const errorMsg = err instanceof Error ? err.message : "Compression failed";
      setError(errorMsg);
      updateJob(jobId, { status: "error", error: errorMsg });
    } finally {
      setIsCompressing(false);
      setProgress(0);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Minimize2 className="w-5 h-5" />
            {t("compressor.title", "Video Compression")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Original File Info */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
            <div>
              <p className="text-sm font-medium">{videoFile?.name || t("compressor.stockVideo", "Stock Video")}</p>
              <p className="text-xs text-muted-foreground">
                {originalSizeMB > 0
                  ? t("compressor.originalSize", "Original: {{size}} MB", { size: originalSizeMB.toFixed(2) })
                  : t("compressor.sizeUnknown", "Size unknown")}
                {videoMetadata && (
                  <span> • {videoMetadata.width}×{videoMetadata.height}</span>
                )}
              </p>
            </div>
            <Badge variant="outline">MP4</Badge>
          </div>

          {/* Video Preview */}
          <div className="aspect-video bg-black rounded-lg overflow-hidden">
            <video
              ref={videoRef}
              src={videoSrc}
              className="w-full h-full object-contain"
              onLoadedMetadata={handleVideoLoad}
              muted
              playsInline
            />
          </div>

          {/* Compression Mode Selection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t("compressor.method", "Compression Method")}</Label>
              <VideoProcessingPresetSelector
                platform="general"
                onApplyPreset={(preset) => {
                  if (preset.compressQuality) {
                    setMode("percentage");
                    setPercentage([preset.compressQuality]);
                  }
                  if (preset.compressMaxSizeMB) {
                    setMode("targetSize");
                    setTargetSizeMB(preset.compressMaxSizeMB.toString());
                  }
                }}
                currentSettings={{
                  compressQuality: percentage[0],
                  compressMaxSizeMB: targetSizeMB ? parseFloat(targetSizeMB) : undefined,
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={mode === "percentage" ? "default" : "outline"}
                className="justify-start gap-2"
                onClick={() => setMode("percentage")}
              >
                <Percent className="w-4 h-4" />
                {t("compressor.byQuality", "By Quality")}
              </Button>
              <Button
                variant={mode === "targetSize" ? "default" : "outline"}
                className="justify-start gap-2"
                onClick={() => setMode("targetSize")}
                disabled={originalSizeMB === 0}
              >
                <HardDrive className="w-4 h-4" />
                {t("compressor.targetSize", "Target Size")}
              </Button>
            </div>
          </div>

          {/* Compression Controls */}
          {mode === "percentage" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>{t("compressor.qualityLabel", "Quality: {{quality}}%", { quality: percentage[0] })}</Label>
                {originalSizeMB > 0 && (
                  <span className="text-sm text-muted-foreground">
                    {t("compressor.estSize", "Est. size: {{size}} MB", { size: estimatedSize.toFixed(2) })}
                  </span>
                )}
              </div>
              <Slider
                value={percentage}
                onValueChange={setPercentage}
                min={20}
                max={100}
                step={5}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t("compressor.smallerFile", "Smaller file (20%)")}</span>
                <span>{t("compressor.betterQuality", "Better quality (100%)")}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Label>{t("compressor.targetFileSize", "Target File Size (MB)")}</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={targetSizeMB}
                  onChange={(e) => setTargetSizeMB(e.target.value)}
                  placeholder={originalSizeMB > 0 ? t("compressor.maxSizePlaceholder", "Max: {{size}}", { size: originalSizeMB.toFixed(1) }) : t("compressor.enterSize", "Enter size")}
                  min={1}
                  max={originalSizeMB > 0 ? Math.floor(originalSizeMB) : 500}
                  step={1}
                />
                <span className="flex items-center text-sm text-muted-foreground">MB</span>
              </div>
              {targetSizeMB && originalSizeMB > 0 && parseFloat(targetSizeMB) >= originalSizeMB && (
                <p className="text-xs text-amber-600">
                  {t("compressor.targetSmallerWarning", "Target size should be smaller than original ({{size}} MB)", { size: originalSizeMB.toFixed(1) })}
                </p>
              )}
            </div>
          )}

          {/* Info Message */}
          {!mediaFileId ? (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {t("compressor.mustUploadFirst", "Video must be uploaded before compression. Please wait for the upload to complete.")}
              </p>
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
              <p className="text-xs text-blue-700 dark:text-blue-300">
                <strong>{t("compressor.serverCompressionTitle", "Server-side compression:")} </strong>{t("compressor.serverCompressionDesc", "Your video will be compressed using Cloudinary's professional video encoding. This produces better quality at smaller file sizes.")}
              </p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
              <p className="text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </p>
            </div>
          )}

          {/* Progress */}
          {isCompressing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>{t("compressor.compressingProgress", "Compressing on server...")}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCompressing}>
            <X className="w-4 h-4 me-2" />
            {t("common:cancel", "Cancel")}
          </Button>
          <Button
            onClick={handleCompress}
            disabled={isCompressing || !mediaFileId || (mode === "targetSize" && !targetSizeMB)}
          >
            {isCompressing ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <Check className="w-4 h-4 me-2" />
            )}
            {t("compressor.compressBtn", "Compress Video")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}
