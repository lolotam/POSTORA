import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, Volume2, VolumeX, Maximize2, Image, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { 
  formatFileSize, 
  validateAspectRatioForPlatforms,
  type AspectRatioValidation 
} from "@/lib/platformMediaSpecs";

// Re-export for backwards compatibility
export { 
  PLATFORM_ASPECT_RATIOS, 
  PLATFORM_FILE_SIZE_LIMITS,
  validateAspectRatioForPlatforms, 
  formatFileSize,
  checkFileSizeForPlatforms,
  type AspectRatioValidation 
} from "@/lib/platformMediaSpecs";

interface VideoPreviewProps {
  src: string;
  className?: string;
  onThumbnailCapture?: (thumbnailUrl: string) => void;
  showThumbnailCapture?: boolean;
  selectedPlatforms?: string[];
  fileSize?: number;
}

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  aspectRatio: string;
}

export function VideoPreview({ 
  src, 
  className,
  onThumbnailCapture,
  showThumbnailCapture = true,
  selectedPlatforms = [],
  fileSize,
}: VideoPreviewProps) {
  const { t } = useTranslation("postpreview");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false);
  const [aspectRatioValidations, setAspectRatioValidations] = useState<AspectRatioValidation[]>([]);

  // Validate aspect ratio when metadata or platforms change
  useEffect(() => {
    if (metadata && selectedPlatforms.length > 0) {
      const validations = validateAspectRatioForPlatforms(
        metadata.width,
        metadata.height,
        selectedPlatforms
      );
      setAspectRatioValidations(validations);
    } else {
      setAspectRatioValidations([]);
    }
  }, [metadata, selectedPlatforms]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setMetadata({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        aspectRatio: `${video.videoWidth}:${video.videoHeight}`,
      });
      
      // Auto-generate thumbnail at 1 second or 25% of duration
      const thumbnailTime = Math.min(1, video.duration * 0.25);
      generateThumbnailAtTime(thumbnailTime);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("ended", handleEnded);
    };
  }, [src]);

  const generateThumbnailAtTime = async (time: number) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    setIsGeneratingThumbnail(true);

    try {
      // Seek to the specified time
      video.currentTime = time;
      
      await new Promise<void>((resolve) => {
        const handleSeeked = () => {
          video.removeEventListener("seeked", handleSeeked);
          resolve();
        };
        video.addEventListener("seeked", handleSeeked);
      });

      // Draw the current frame to canvas
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Convert to data URL
      const thumbnailUrl = canvas.toDataURL("image/jpeg", 0.8);
      setThumbnail(thumbnailUrl);
      onThumbnailCapture?.(thumbnailUrl);
    } catch (error) {
      console.error("Failed to generate thumbnail:", error);
    } finally {
      setIsGeneratingThumbnail(false);
    }
  };

  const handlePlayPause = async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      if (isPlaying) {
        video.pause();
        setIsPlaying(false);
      } else {
        await video.play();
        setIsPlaying(true);
      }
    } catch (err) {
      console.error("Video play failed:", err);
      setIsPlaying(false);
    }
  };

  const handleMuteToggle = () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleSeek = (value: number[]) => {
    const video = videoRef.current;
    if (!video) return;

    video.currentTime = value[0];
    setCurrentTime(value[0]);
  };

  const handleCaptureThumbnail = () => {
    generateThumbnailAtTime(currentTime);
  };

  const handleFullscreen = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.requestFullscreen) {
      video.requestFullscreen();
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Video Player */}
      <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full object-contain"
          muted={isMuted}
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
        />
        
        {/* Controls Overlay */}
        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 hover:opacity-100 transition-opacity">
          {/* Progress Bar */}
          <div className="px-3 pb-1">
            <Slider
              value={[currentTime]}
              min={0}
              max={duration || 100}
              step={0.1}
              onValueChange={handleSeek}
              className="cursor-pointer"
            />
          </div>

          {/* Control Buttons */}
          <div className="flex items-center justify-between px-3 pb-3">
            <div className="flex items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handlePlayPause}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleMuteToggle}
              >
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </Button>
              <span className="text-xs text-white/80 font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {showThumbnailCapture && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-white hover:bg-white/20 text-xs gap-1"
                  onClick={handleCaptureThumbnail}
                  disabled={isGeneratingThumbnail}
                >
                  {isGeneratingThumbnail ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Image className="w-3 h-3" />
                  )}
                  {t("videoPreview.capture", "Capture")}
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleFullscreen}
              >
                <Maximize2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Hidden canvas for thumbnail generation */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Metadata Display */}
      {metadata && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2 py-1 rounded bg-secondary text-muted-foreground">
            {Math.floor(metadata.duration / 60)}:{Math.floor(metadata.duration % 60).toString().padStart(2, "0")}
          </span>
          <span className="px-2 py-1 rounded bg-secondary text-muted-foreground">
            {metadata.width}×{metadata.height}
          </span>
          <span className="px-2 py-1 rounded bg-secondary text-muted-foreground">
            {t("videoPreview.ratio", { ratio: (metadata.width / metadata.height).toFixed(2), defaultValue: `${(metadata.width / metadata.height).toFixed(2)} ratio` })}
          </span>
          {fileSize && (
            <span className="px-2 py-1 rounded bg-secondary text-muted-foreground">
              {formatFileSize(fileSize)}
            </span>
          )}
        </div>
      )}

      {/* Aspect Ratio Validation */}
      {aspectRatioValidations.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t("videoPreview.platformCheck", "Platform Aspect Ratio Check")}</p>
          <div className="flex flex-wrap gap-2">
            {aspectRatioValidations.map((validation) => (
              <div
                key={validation.platform}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded text-xs",
                  validation.isValid
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                )}
              >
                {validation.isValid ? (
                  <CheckCircle2 className="w-3 h-3" />
                ) : (
                  <AlertTriangle className="w-3 h-3" />
                )}
                <span className="font-medium">{validation.platform}</span>
                {!validation.isValid && (
                  <span className="text-muted-foreground">
                    → {validation.suggestion}
                  </span>
                )}
              </div>
            ))}
          </div>
          {aspectRatioValidations.some(v => !v.isValid) && (
            <p className="text-xs text-muted-foreground">
              {t("videoPreview.cropToolHint", "Use the crop tool to adjust the video frame for optimal display on each platform")}
            </p>
          )}
        </div>
      )}

      {/* Thumbnail Preview */}
      {thumbnail && showThumbnailCapture && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium">{t("videoPreview.generatedThumbnail", "Generated Thumbnail")}</p>
          <div className="relative w-32 aspect-video rounded-lg overflow-hidden border border-border">
            <img src={thumbnail} alt={t("videoPreview.thumbnailAlt", "Video thumbnail")} className="w-full h-full object-cover" />
          </div>
        </div>
      )}
    </div>
  );
}
