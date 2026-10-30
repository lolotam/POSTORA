import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Crop, RotateCcw, ZoomIn, Check, X, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { invokeErrorMessage } from "@/lib/functionInvokeError";
import { useProcessingJobsContext } from "@/contexts/ProcessingJobsContext";
import { VideoProcessingPresetSelector } from "./VideoProcessingPresetSelector";

interface MediaCropperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaSrc: string;
  mediaType: "image" | "video" | "gif";
  targetAspectRatio?: string;
  onCropComplete: (croppedBlob: Blob, croppedUrl: string, newMediaFileId?: string) => void;
  platforms?: string[];
  mediaFileId?: string | null; // Database ID for server-side video processing
}

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Aspect ratio presets
const ASPECT_RATIOS = [
  { value: "1:1", label: "Square (1:1)", ratio: 1 },
  { value: "4:5", label: "Portrait (4:5)", ratio: 4 / 5 },
  { value: "9:16", label: "Vertical (9:16)", ratio: 9 / 16 },
  { value: "16:9", label: "Landscape (16:9)", ratio: 16 / 9 },
  { value: "4:3", label: "Standard (4:3)", ratio: 4 / 3 },
  { value: "2:3", label: "Pinterest (2:3)", ratio: 2 / 3 },
  { value: "free", label: "Free Crop", ratio: 0 },
];

// Quality preset options for processing speed vs quality tradeoff
const QUALITY_PRESETS = [
  { value: "fast", label: "Fast", description: "Lower quality, faster processing" },
  { value: "balanced", label: "Balanced", description: "Good quality, moderate speed" },
  { value: "high", label: "High Quality", description: "Best quality, slower processing" },
];

// Target resolutions based on aspect ratio and quality setting
const getTargetResolution = (aspectRatio: string, quality: string): { width: number; height: number } | null => {
  const resolutions: Record<string, Record<string, { width: number; height: number }>> = {
    "9:16": {
      fast: { width: 540, height: 960 },
      balanced: { width: 720, height: 1280 },
      high: { width: 1080, height: 1920 },
    },
    "4:5": {
      fast: { width: 720, height: 900 },
      balanced: { width: 1080, height: 1350 },
      high: { width: 1440, height: 1800 },
    },
    "16:9": {
      fast: { width: 854, height: 480 },
      balanced: { width: 1280, height: 720 },
      high: { width: 1920, height: 1080 },
    },
    "1:1": {
      fast: { width: 720, height: 720 },
      balanced: { width: 1080, height: 1080 },
      high: { width: 1440, height: 1440 },
    },
    "4:3": {
      fast: { width: 640, height: 480 },
      balanced: { width: 1024, height: 768 },
      high: { width: 1600, height: 1200 },
    },
    "2:3": {
      fast: { width: 600, height: 900 },
      balanced: { width: 800, height: 1200 },
      high: { width: 1000, height: 1500 },
    },
  };
  
  return resolutions[aspectRatio]?.[quality] || null;
};

// Platform recommended ratios
const PLATFORM_RECOMMENDED_RATIOS: Record<string, string> = {
  tiktok: "9:16",
  instagram: "4:5",
  youtube: "16:9",
  facebook: "1:1",
  twitter: "16:9",
  linkedin: "1:1",
  pinterest: "2:3",
};

export function MediaCropper({
  open,
  onOpenChange,
  mediaSrc,
  mediaType,
  targetAspectRatio,
  onCropComplete,
  platforms = [],
  mediaFileId,
}: MediaCropperProps) {
  const { t } = useTranslation("postmedia");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [selectedRatio, setSelectedRatio] = useState(targetAspectRatio || "1:1");
  const [zoom, setZoom] = useState([1]);
  const [cropArea, setCropArea] = useState<CropArea>({ x: 0, y: 0, width: 100, height: 100 });
  const [mediaDimensions, setMediaDimensions] = useState({ width: 0, height: 0 });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [qualityPreset, setQualityPreset] = useState<string>("balanced");

  const getRatioLabel = (value: string, defaultLabel: string) => {
    switch (value) {
      case "1:1": return t("cropper.ratioSquare", defaultLabel);
      case "4:5": return t("cropper.ratioPortrait45", defaultLabel);
      case "9:16": return t("cropper.ratioVertical916", defaultLabel);
      case "16:9": return t("cropper.ratioLandscape169", defaultLabel);
      case "4:3": return t("cropper.ratioStandard43", defaultLabel);
      case "2:3": return t("cropper.ratioPinterest23", defaultLabel);
      case "free": return t("cropper.ratioFree", defaultLabel);
      default: return defaultLabel;
    }
  };

  const getQualityPresetInfo = (value: string, defaultLabel: string, defaultDesc: string) => {
    switch (value) {
      case "fast":
        return {
          label: t("cropper.qualityFast", defaultLabel),
          description: t("cropper.qualityFastDesc", defaultDesc),
        };
      case "balanced":
        return {
          label: t("cropper.qualityBalanced", defaultLabel),
          description: t("cropper.qualityBalancedDesc", defaultDesc),
        };
      case "high":
        return {
          label: t("cropper.qualityHigh", defaultLabel),
          description: t("cropper.qualityHighDesc", defaultDesc),
        };
      default:
        return { label: defaultLabel, description: defaultDesc };
    }
  };

  // Calculate expected output resolution
  const expectedResolution = useMemo(() => {
    if (!mediaDimensions.width || !mediaDimensions.height) return null;
    
    // Calculate cropped dimensions from source
    const croppedWidth = Math.round((cropArea.width / 100) * mediaDimensions.width);
    const croppedHeight = Math.round((cropArea.height / 100) * mediaDimensions.height);
    
    // Get target resolution based on aspect ratio and quality
    const targetRes = getTargetResolution(selectedRatio, qualityPreset);
    
    if (targetRes && mediaType === "video") {
      // For videos, we upscale to target if cropped is smaller
      if (croppedWidth < targetRes.width || croppedHeight < targetRes.height) {
        return { 
          width: targetRes.width, 
          height: targetRes.height,
          upscaled: true,
          original: { width: croppedWidth, height: croppedHeight }
        };
      }
    }
    
    return { 
      width: croppedWidth, 
      height: croppedHeight,
      upscaled: false,
      original: null
    };
  }, [mediaDimensions, cropArea, selectedRatio, qualityPreset, mediaType]);

  // Calculate the actual displayed image bounds within the object-contain container
  const imageBounds = useMemo(() => {
    if (!mediaDimensions.width || !mediaDimensions.height || !containerSize.width || !containerSize.height) {
      return { left: 0, top: 0, width: 100, height: 100 };
    }

    const containerRatio = containerSize.width / containerSize.height;
    const mediaRatio = mediaDimensions.width / mediaDimensions.height;

    let displayWidth: number;
    let displayHeight: number;

    if (mediaRatio > containerRatio) {
      // Image is wider than container - fit to width
      displayWidth = containerSize.width;
      displayHeight = containerSize.width / mediaRatio;
    } else {
      // Image is taller than container - fit to height
      displayHeight = containerSize.height;
      displayWidth = containerSize.height * mediaRatio;
    }

    const left = (containerSize.width - displayWidth) / 2;
    const top = (containerSize.height - displayHeight) / 2;

    return {
      left: (left / containerSize.width) * 100,
      top: (top / containerSize.height) * 100,
      width: (displayWidth / containerSize.width) * 100,
      height: (displayHeight / containerSize.height) * 100,
    };
  }, [mediaDimensions, containerSize]);

  // Calculate crop area based on aspect ratio - properly maps to displayed image area
  const calculateCropArea = useCallback((ratio: string) => {
    if (!mediaDimensions.width || !mediaDimensions.height) return;

    const ratioInfo = ASPECT_RATIOS.find((r) => r.value === ratio);
    if (!ratioInfo || ratioInfo.ratio === 0) {
      setCropArea({ x: 0, y: 0, width: 100, height: 100 });
      return;
    }

    const mediaRatio = mediaDimensions.width / mediaDimensions.height;
    const targetRatio = ratioInfo.ratio;

    let cropWidth: number;
    let cropHeight: number;

    // Calculate crop dimensions that will produce the exact target aspect ratio
    if (targetRatio > mediaRatio) {
      // Target is wider than media - use full width, reduce height
      cropWidth = 100;
      // The crop height as percentage needs to give us the target ratio
      // (cropWidth% * mediaWidth) / (cropHeight% * mediaHeight) = targetRatio
      // cropHeight% = (cropWidth% * mediaWidth) / (targetRatio * mediaHeight)
      // cropHeight% = (100 * mediaRatio) / targetRatio
      cropHeight = (mediaRatio / targetRatio) * 100;
    } else {
      // Target is taller or same as media - use full height, reduce width
      cropHeight = 100;
      // cropWidth% = (cropHeight% * targetRatio * mediaHeight) / mediaWidth
      // cropWidth% = (100 * targetRatio) / mediaRatio
      cropWidth = (targetRatio / mediaRatio) * 100;
    }

    // Center the crop area
    setCropArea({
      x: (100 - cropWidth) / 2,
      y: (100 - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    });
  }, [mediaDimensions]);

  useEffect(() => {
    calculateCropArea(selectedRatio);
  }, [selectedRatio, calculateCropArea]);

  const handleMediaLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
    const target = e.currentTarget;
    const width = target instanceof HTMLVideoElement ? target.videoWidth : target.naturalWidth;
    const height = target instanceof HTMLVideoElement ? target.videoHeight : target.naturalHeight;
    setMediaDimensions({ width, height });
    
    // Also get container size
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    }
  }, []);

  // Update container size on resize
  useEffect(() => {
    if (!containerRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !containerRef.current) return;

    const container = containerRef.current.getBoundingClientRect();
    const deltaX = ((e.clientX - dragStart.x) / container.width) * 100;
    const deltaY = ((e.clientY - dragStart.y) / container.height) * 100;

    setCropArea((prev) => {
      const newX = Math.max(0, Math.min(100 - prev.width, prev.x + deltaX));
      const newY = Math.max(0, Math.min(100 - prev.height, prev.y + deltaY));
      return { ...prev, x: newX, y: newY };
    });

    setDragStart({ x: e.clientX, y: e.clientY });
  }, [isDragging, dragStart]);

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleReset = () => {
    setZoom([1]);
    calculateCropArea(selectedRatio);
  };

  const { addJob, updateJob } = useProcessingJobsContext();

  const handleApplyCrop = async () => {
    if (!mediaRef.current || !canvasRef.current) return;

    // For videos, require mediaFileId (stock videos must finish uploading first)
    if (mediaType === "video" && !mediaFileId) {
      console.error("Cannot crop video: mediaFileId is required for server-side processing");
      return;
    }

    const jobId = `crop-${Date.now()}`;
    const fileName = mediaType === "video" ? "Video" : "Image";
    
    // Add job to processing panel with retry context
    addJob({
      id: jobId,
      fileId: mediaFileId || jobId,
      fileName: `${fileName} Crop`,
      operation: "crop",
      status: "processing",
      progress: 0,
      retryContext: {
        mediaSrc,
        mediaType,
        targetRatio: selectedRatio,
        mediaFileId: mediaFileId || undefined,
      },
    });

    setIsProcessing(true);

    try {
      // For videos, use server-side processing (Openinary)
      if (mediaType === "video" && mediaFileId) {
        updateJob(jobId, { progress: 20 });
        
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Not authenticated");

        updateJob(jobId, { progress: 40 });

        // Get target resolution based on aspect ratio and quality setting
        const targetRes = getTargetResolution(selectedRatio, qualityPreset);
        let targetWidth: number | undefined = targetRes?.width;
        let targetHeight: number | undefined = targetRes?.height;

        // Server-side video crop; the target resolution upscales a smaller crop
        const { data, error: invokeError } = await supabase.functions.invoke("process-video", {
          body: {
            media_file_id: mediaFileId,
            user_id: user.id,
            operation: "crop",
            crop: {
              x: cropArea.x,
              y: cropArea.y,
              width: cropArea.width,
              height: cropArea.height,
              targetWidth,
              targetHeight,
            },
            // The crop box is a percentage of the frame, so the server needs the frame size.
            source_dimensions: mediaDimensions.width && mediaDimensions.height
              ? { width: mediaDimensions.width, height: mediaDimensions.height }
              : undefined,
          },
        });

        if (invokeError) throw new Error(await invokeErrorMessage(invokeError, "Crop failed"));
        if (!data.success) throw new Error(data.error || "Crop failed");

        updateJob(jobId, { progress: 80 });

        // Fetch the cropped video to create a blob for the callback
        const response = await fetch(data.processed_url);
        const blob = await response.blob();

        updateJob(jobId, { status: "done", progress: 100 });

        onCropComplete(blob, data.processed_url, data.new_media_file_id);
        onOpenChange(false);
        return;
      }

      // For images, use client-side canvas cropping
      updateJob(jobId, { progress: 30 });
      
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");

      const media = mediaRef.current;
      const srcWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
      const srcHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;

      // Calculate actual crop dimensions
      const cropX = (cropArea.x / 100) * srcWidth;
      const cropY = (cropArea.y / 100) * srcHeight;
      const cropWidth = (cropArea.width / 100) * srcWidth;
      const cropHeight = (cropArea.height / 100) * srcHeight;

      // Set canvas size to cropped dimensions
      canvas.width = cropWidth;
      canvas.height = cropHeight;

      updateJob(jobId, { progress: 60 });

      // Draw cropped area
      ctx.drawImage(
        media,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight
      );

      // Convert to blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else reject(new Error("Failed to create blob"));
          },
          "image/jpeg",
          0.92
        );
      });

      updateJob(jobId, { status: "done", progress: 100 });

      const croppedUrl = URL.createObjectURL(blob);
      onCropComplete(blob, croppedUrl);
      onOpenChange(false);
    } catch (error) {
      console.error("Crop failed:", error);
      updateJob(jobId, { 
        status: "error", 
        error: error instanceof Error ? error.message : "Crop failed" 
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Get recommended ratios for selected platforms
  const recommendedRatios = [...new Set(
    platforms.map((p) => PLATFORM_RECOMMENDED_RATIOS[p.toLowerCase()]).filter(Boolean)
  )];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crop className="w-5 h-5" />
            {mediaType === "image"
              ? t("cropper.titleImage", "Crop Image")
              : t("cropper.titleVideo", "Crop Video Frame")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Preset Selector + Aspect Ratio Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("cropper.aspectRatio", "Aspect Ratio")}</Label>
              <VideoProcessingPresetSelector
                platform={platforms[0]?.toLowerCase() || "general"}
                onApplyPreset={(preset) => {
                  if (preset.cropAspectRatio) {
                    setSelectedRatio(preset.cropAspectRatio);
                  }
                }}
                currentSettings={{ cropAspectRatio: selectedRatio }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {ASPECT_RATIOS.map((ratio) => (
                <Button
                  key={ratio.value}
                  variant={selectedRatio === ratio.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedRatio(ratio.value)}
                  className="gap-1"
                >
                  {getRatioLabel(ratio.value, ratio.label)}
                  {recommendedRatios.includes(ratio.value) && (
                    <Badge variant="secondary" className="text-xs ms-1">
                      {t("cropper.recommended", "Recommended")}
                    </Badge>
                  )}
                </Button>
              ))}
            </div>
            {platforms.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("cropper.recommendedFor", "Recommended for {{platforms}}: {{ratios}}", {
                  platforms: platforms.join(", "),
                  ratios: recommendedRatios.join(", "),
                })}
              </p>
            )}
          </div>

          {/* Crop Preview */}
          <div
            ref={containerRef}
            className="relative aspect-video bg-black rounded-lg overflow-hidden"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Media */}
            {mediaType === "image" ? (
              <img
                ref={mediaRef as React.RefObject<HTMLImageElement>}
                src={mediaSrc}
                alt={t("cropper.previewAlt", "Crop preview")}
                className="w-full h-full object-contain"
                style={{ transform: `scale(${zoom[0]})` }}
                onLoad={handleMediaLoad}
                crossOrigin="anonymous"
              />
            ) : (
              <video
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                src={mediaSrc}
                className="w-full h-full object-contain"
                style={{ transform: `scale(${zoom[0]})` }}
                onLoadedMetadata={handleMediaLoad}
                muted
              />
            )}

            {/* Crop Overlay - positioned relative to actual image bounds */}
            <div 
              className="absolute pointer-events-none"
              style={{
                left: `${imageBounds.left}%`,
                top: `${imageBounds.top}%`,
                width: `${imageBounds.width}%`,
                height: `${imageBounds.height}%`,
              }}
            >
              {/* Dark overlay outside crop area */}
              <div
                className="absolute inset-0 bg-black/50"
                style={{
                  clipPath: `polygon(
                    0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                    ${cropArea.x}% ${cropArea.y}%,
                    ${cropArea.x}% ${cropArea.y + cropArea.height}%,
                    ${cropArea.x + cropArea.width}% ${cropArea.y + cropArea.height}%,
                    ${cropArea.x + cropArea.width}% ${cropArea.y}%,
                    ${cropArea.x}% ${cropArea.y}%
                  )`,
                }}
              />

              {/* Crop area border */}
              <div
                className="absolute border-2 border-white cursor-move pointer-events-auto"
                style={{
                  left: `${cropArea.x}%`,
                  top: `${cropArea.y}%`,
                  width: `${cropArea.width}%`,
                  height: `${cropArea.height}%`,
                }}
                onMouseDown={handleMouseDown}
              >
                {/* Grid lines */}
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
                  {[...Array(9)].map((_, i) => (
                    <div key={i} className="border border-white/30" />
                  ))}
                </div>

                {/* Corner handles */}
                {["top-left", "top-right", "bottom-left", "bottom-right"].map((pos) => (
                  <div
                    key={pos}
                    className={cn(
                      "absolute w-3 h-3 bg-white rounded-full",
                      pos === "top-left" && "top-0 start-0 -translate-x-1/2 -translate-y-1/2",
                      pos === "top-right" && "top-0 end-0 translate-x-1/2 -translate-y-1/2",
                      pos === "bottom-left" && "bottom-0 start-0 -translate-x-1/2 translate-y-1/2",
                      pos === "bottom-right" && "bottom-0 end-0 translate-x-1/2 translate-y-1/2"
                    )}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Zoom Control */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <ZoomIn className="w-4 h-4" />
                {t("cropper.zoom", "Zoom")}
              </Label>
              <span className="text-sm text-muted-foreground">{Math.round(zoom[0] * 100)}%</span>
            </div>
            <Slider
              value={zoom}
              min={1}
              max={3}
              step={0.1}
              onValueChange={setZoom}
            />
          </div>

          {/* Quality Preset for Videos */}
          {mediaType === "video" && selectedRatio !== "free" && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("cropper.processingQuality", "Processing Quality")}</Label>
              <div className="flex gap-2">
                {QUALITY_PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    variant={qualityPreset === preset.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setQualityPreset(preset.value)}
                    className="flex-1"
                  >
                    {getQualityPresetInfo(preset.value, preset.label, preset.description).label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const current = QUALITY_PRESETS.find((p) => p.value === qualityPreset);
                  return current ? getQualityPresetInfo(current.value, current.label, current.description).description : "";
                })()}
              </p>
            </div>
          )}

          {/* Resolution Preview */}
          {mediaDimensions.width > 0 && (
            <div className="p-3 rounded-lg bg-muted/50 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("cropper.sourceLabel", "Source:")}</span>
                <span className="font-mono">{mediaDimensions.width}×{mediaDimensions.height}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("cropper.croppedLabel", "Cropped:")}</span>
                <span className="font-mono">
                  {Math.round((cropArea.width / 100) * mediaDimensions.width)}×
                  {Math.round((cropArea.height / 100) * mediaDimensions.height)}
                </span>
              </div>
              {expectedResolution && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("cropper.outputLabel", "Output:")}</span>
                  <span className={cn(
                    "font-mono font-medium",
                    expectedResolution.upscaled ? "text-primary" : ""
                  )}>
                    {expectedResolution.width}×{expectedResolution.height}
                    {expectedResolution.upscaled && (
                      <Badge variant="secondary" className="ms-2 text-[10px]">{t("cropper.upscaled", "Upscaled")}</Badge>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="w-4 h-4 me-2" />
            {t("cropper.reset", "Reset")}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <X className="w-4 h-4 me-2" />
            {t("common:cancel", "Cancel")}
          </Button>
          {/* Show warning if video is still uploading (no mediaFileId) */}
          {mediaType === "video" && !mediaFileId ? (
            <Button disabled className="gap-2">
              <AlertCircle className="w-4 h-4" />
              {t("cropper.waitForUpload", "Wait for upload to finish")}
            </Button>
          ) : (
            <Button onClick={handleApplyCrop} disabled={isProcessing}>
              {isProcessing ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Check className="w-4 h-4 me-2" />
              )}
              {t("cropper.applyCrop", "Apply Crop")}
            </Button>
          )}
        </DialogFooter>

        {/* Hidden canvas for cropping */}
        <canvas ref={canvasRef} className="hidden" />
      </DialogContent>
    </Dialog>
  );
}

export { ASPECT_RATIOS, PLATFORM_RECOMMENDED_RATIOS };
