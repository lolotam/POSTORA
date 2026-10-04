// ═══════════════════════════════════════════════════════════════════════════
// TikTok Preview Dialog
// Full-page preview matching TikTok's official upload interface
// Shows video preview with file info and upload form summary
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo, useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  ChevronLeft,
  Play,
  Pause,
  Maximize2,
  Volume2,
  VolumeX,
  FileVideo,
  AlertCircle,
  Check,
  AlertTriangle,
} from "lucide-react";
import type { TikTokSettingsState, TikTokCreatorInfo } from "./settings/TikTokSettings";
import { tiktokPrivacyOptions } from "@/lib/platformConstants";

interface TikTokPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaFiles: Array<{
    previewUrl?: string;
    fileType: "image" | "video" | "gif";
    file?: File;
    fileName?: string;
  }>;
  /** Main post caption (4000 chars) */
  caption: string;
  /** TikTok-specific title override (100 chars) */
  title: string;
  onTitleChange?: (title: string) => void;
  settings: TikTokSettingsState;
  onSettingsChange?: (changes: Partial<TikTokSettingsState>) => void;
  creatorInfo: TikTokCreatorInfo | null;
  onUpload?: () => void;
  isUploading?: boolean;
  scheduleEnabled?: boolean;
}

// Helper to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + sizes[i];
}

// Helper to get file format from mime type or extension
function getFileFormat(file?: File, fileName?: string): string {
  if (file?.type) {
    const parts = file.type.split("/");
    return parts[1]?.toUpperCase() || "Unknown";
  }
  if (fileName) {
    const ext = fileName.split(".").pop();
    return ext?.toUpperCase() || "Unknown";
  }
  return "Unknown";
}

// Square Checkbox Component
function SquareCheckbox({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className={cn("flex items-center gap-2 cursor-pointer", disabled && "opacity-50 cursor-not-allowed")}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        className={cn(
          "w-5 h-5 rounded-[4px] border-2 flex items-center justify-center transition-all",
          checked
            ? "bg-[#25f4ee] border-[#25f4ee]"
            : "border-gray-400 bg-transparent hover:border-[#25f4ee]",
          disabled && "cursor-not-allowed"
        )}
      >
        {checked && <Check className="w-3.5 h-3.5 text-black" strokeWidth={3} />}
      </button>
      <span className="text-sm">{label}</span>
    </label>
  );
}

export function TikTokPreviewDialog({
  open,
  onOpenChange,
  mediaFiles,
  caption,
  title,
  onTitleChange,
  settings,
  onSettingsChange,
  creatorInfo,
  onUpload,
  isUploading = false,
  scheduleEnabled = false,
}: TikTokPreviewDialogProps) {
  const { t } = useTranslation("postpreview");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoResolution, setVideoResolution] = useState<string>("--");

  const previewMedia = mediaFiles[0];
  const isVideo = previewMedia?.fileType === "video";
  const file = previewMedia?.file;

  // Check video duration against max allowed
  const maxDurationSec = creatorInfo?.max_video_post_duration_sec;
  const isDurationExceeded = isVideo && maxDurationSec && duration > maxDurationSec;

  // Handle video events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      if (video.videoWidth && video.videoHeight) {
        const height = video.videoHeight;
        if (height >= 2160) setVideoResolution("4K");
        else if (height >= 1080) setVideoResolution("1080P");
        else if (height >= 720) setVideoResolution("720P");
        else if (height >= 480) setVideoResolution("480P");
        else setVideoResolution(`${height}P`);
      }
    };
    const handleEnded = () => setIsPlaying(false);

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("ended", handleEnded);
    };
  }, [open]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [open]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    video.currentTime = percent * duration;
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Get file name without extension for display
  const getDisplayFileName = () => {
    const name = file?.name || previewMedia?.fileName || "Unknown";
    const lastDot = name.lastIndexOf(".");
    return lastDot > 0 ? name.substring(0, lastDot) : name;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[95vw] max-h-[90vh] overflow-y-auto p-0 bg-white dark:bg-background">
        {/* Header */}
        <DialogHeader className="p-6 pb-4">
          <div className="flex items-center gap-3">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            >
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
            </motion.div>
            <DialogTitle className="text-xl font-semibold">
              {isVideo ? t("tikTokDialog.videoReady", "Your video is ready!") : t("tikTokDialog.photoReady", "Your photo is ready!")}
            </DialogTitle>
          </div>
        </DialogHeader>

        {/* Main Content - Three Column Layout */}
        <div className="grid lg:grid-cols-[1fr_1fr_1fr] gap-6 px-6 pb-6">
          {/* Left Column: Video Preview with Black Frame */}
          <div className="bg-black rounded-xl overflow-hidden flex flex-col">
            {/* Video Player */}
            <div className="relative flex-1 min-h-[400px]">
              {previewMedia?.previewUrl ? (
                isVideo ? (
                  <>
                    <video
                      ref={videoRef}
                      src={previewMedia.previewUrl}
                      className="w-full h-full object-contain"
                      muted={isMuted}
                      playsInline
                      onClick={togglePlay}
                    />

                    {/* Play/Pause Button Overlay */}
                    <AnimatePresence>
                      {!isPlaying && (
                        <motion.button
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          onClick={togglePlay}
                          className="absolute inset-0 flex items-center justify-center"
                        >
                          <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center">
                            <Play className="w-8 h-8 text-white ms-1" />
                          </div>
                        </motion.button>
                      )}
                    </AnimatePresence>

                    {/* Bottom Controls */}
                    <div className="absolute bottom-0 start-0 end-0 p-3 space-y-2 bg-gradient-to-t from-black/80 to-transparent">
                      {/* Progress Bar */}
                      <div
                        className="h-1 bg-white/30 rounded-full cursor-pointer"
                        onClick={handleSeek}
                      >
                        <div
                          className="h-full bg-white rounded-full transition-all"
                          style={{ width: `${(currentTime / duration) * 100 || 0}%` }}
                        />
                      </div>

                      {/* Controls Row */}
                      <div className="flex items-center justify-between text-white text-sm">
                        <div className="flex items-center gap-3">
                          <button onClick={togglePlay} className="hover:opacity-80">
                            {isPlaying ? (
                              <Pause className="w-5 h-5" />
                            ) : (
                              <Play className="w-5 h-5" />
                            )}
                          </button>
                          <span className="text-xs">
                            {formatTime(currentTime)} | {formatTime(duration)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <button onClick={toggleMute} className="hover:opacity-80">
                            {isMuted ? (
                              <VolumeX className="w-5 h-5" />
                            ) : (
                              <Volume2 className="w-5 h-5" />
                            )}
                          </button>
                          <button className="hover:opacity-80">
                            <Maximize2 className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <img
                    src={previewMedia.previewUrl}
                    alt={t("tikTokDialog.previewAlt", "Preview")}
                    className="w-full h-full object-contain"
                  />
                )
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-500">
                  <FileVideo className="w-12 h-12" />
                </div>
              )}
            </div>

            {/* File Information Bar - Inside Black Frame */}
            <div className="grid grid-cols-4 gap-2 p-4 text-white border-t border-white/10">
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">{t("tikTokDialog.filename", "Filename")}</p>
                <p className="text-xs font-medium truncate mt-0.5">
                  {getDisplayFileName()}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">{t("tikTokDialog.format", "Format")}</p>
                <p className="text-xs font-medium mt-0.5">
                  {getFileFormat(file, previewMedia?.fileName)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">{t("tikTokDialog.resolution", "Resolution")}</p>
                <p className="text-xs font-medium mt-0.5">{videoResolution}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">{t("tikTokDialog.size", "Size")}</p>
                <p className="text-xs font-medium mt-0.5">
                  {file?.size ? formatFileSize(file.size) : "--"}
                </p>
              </div>
            </div>
          </div>

          {/* Center Column: Upload Form */}
          <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenChange(false)}
                className="h-8 w-8"
              >
                <ChevronLeft className="w-5 h-5" />
              </Button>
              <h2 className="text-xl font-bold">{t("tikTokDialog.uploadToTikTok", "Upload to TikTok")}</h2>
            </div>

            {/* Account Selector */}
            <div className="flex items-center justify-between p-3 border rounded-xl">
              <div className="flex items-center gap-3">
                <div className="relative">
                  {creatorInfo?.creator_avatar_url ? (
                    <img
                      src={creatorInfo.creator_avatar_url}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold bg-black">
                      TT
                    </div>
                  )}
                  <div className="absolute -bottom-1 -end-1 w-4 h-4 bg-black rounded-full flex items-center justify-center">
                    <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 text-white" fill="currentColor">
                      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                    </svg>
                  </div>
                </div>
                <span className="font-semibold text-sm">
                  {creatorInfo?.creator_nickname || t("tikTokDialog.defaultAccountName", "TikTok Account")}
                </span>
              </div>
              <ChevronLeft className="w-5 h-5 rotate-180 text-muted-foreground" />
            </div>

            {/* Title Override (100 chars) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("tikTokDialog.titleOverride", "Title override")}</Label>
              <div className="relative">
                <Textarea
                  value={title}
                  onChange={(e) => onTitleChange?.(e.target.value)}
                  placeholder={t("tikTokDialog.titlePlaceholder", "Add a title that describes your video (optional - will use caption if empty)")}
                  maxLength={100}
                  className="min-h-[60px] resize-none pe-16 border rounded-xl"
                />
                <span className="absolute bottom-3 end-3 text-xs text-muted-foreground">
                  {title.length}/100
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("tikTokDialog.titleHint", "If empty, the main caption will be used as the title")}
              </p>
            </div>
            
            {/* Caption Preview (read-only) */}
            {caption && (
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">{t("tikTokDialog.captionFromMain", "Caption (from main post)")}</Label>
                <div className="p-3 bg-muted/50 rounded-xl text-sm text-muted-foreground max-h-[80px] overflow-y-auto">
                  {caption.length > 150 ? `${caption.slice(0, 150)}...` : caption}
                </div>
              </div>
            )}

            {/* Privacy */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("tikTokDialog.whoCanView", "Who can view this video")}</Label>
              <Select
                value={settings.privacyLevel}
                onValueChange={(value) => onSettingsChange?.({ privacyLevel: value })}
              >
                <SelectTrigger className="w-full rounded-xl">
                  <SelectValue placeholder={t("tikTokDialog.selectPrivacyLevel", "Select privacy level")} />
                </SelectTrigger>
                <SelectContent>
                  {(creatorInfo?.privacy_level_options || tiktokPrivacyOptions.map(o => o.value)).map((option) => {
                    const optionInfo = tiktokPrivacyOptions.find(o => o.value === option);
                    return (
                      <SelectItem key={option} value={option}>
                        {optionInfo?.label || option}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Allow users to - Square Checkboxes */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">{t("tikTokDialog.allowUsersTo", "Allow users to")}</Label>
              <div className="flex flex-wrap gap-6">
                <SquareCheckbox
                  checked={settings.allowComment}
                  onCheckedChange={(checked) => onSettingsChange?.({ allowComment: checked })}
                  disabled={creatorInfo?.comment_disabled}
                  label={t("tikTokDialog.comment", "Comment")}
                />
                <SquareCheckbox
                  checked={settings.allowDuet}
                  onCheckedChange={(checked) => onSettingsChange?.({ allowDuet: checked })}
                  disabled={creatorInfo?.duet_disabled}
                  label={t("tikTokDialog.duet", "Duet")}
                />
                <SquareCheckbox
                  checked={settings.allowStitch}
                  onCheckedChange={(checked) => onSettingsChange?.({ allowStitch: checked })}
                  disabled={creatorInfo?.stitch_disabled}
                  label={t("tikTokDialog.stitch", "Stitch")}
                />
              </div>
            </div>

            {/* Disclose video content toggle (in center column) */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">{t("tikTokDialog.discloseVideoContent", "Disclose video content")}</Label>
                <Switch
                  checked={settings.discloseContent}
                  onCheckedChange={(checked) => onSettingsChange?.({ discloseContent: checked })}
                  className="data-[state=checked]:bg-[#25f4ee]"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("tikTokDialog.discloseDescriptionShort", "Turn on to disclose that this video promotes goods or services in exchange for something of value. Your video")}
              </p>
            </div>

            {/* Upload Button */}
            <Button
              onClick={onUpload}
              disabled={isUploading || isDurationExceeded}
              className="w-full h-12 bg-[#22D3EE] hover:bg-[#06B6D4] text-white font-semibold text-base disabled:opacity-50 rounded-xl"
            >
              {isUploading ? (
                <>
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    className="w-5 h-5 me-2 border-2 border-white/30 border-t-white rounded-full"
                  />
                  {t("tikTokDialog.uploading", "Uploading...")}
                </>
              ) : scheduleEnabled ? (
                t("tikTokDialog.schedule", "Schedule")
              ) : (
                t("tikTokDialog.upload", "Upload")
              )}
            </Button>
          </div>

          {/* Right Column: Disclosure Panel (shown when disclose is ON) */}
          <AnimatePresence mode="wait">
            {settings.discloseContent ? (
              <motion.div
                key="disclosure-panel"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-4"
              >
                {/* Header with Toggle */}
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{t("tikTokDialog.discloseVideoContent", "Disclose video content")}</h3>
                  <Switch
                    checked={settings.discloseContent}
                    onCheckedChange={(checked) => onSettingsChange?.({ discloseContent: checked })}
                    className="data-[state=checked]:bg-[#25f4ee]"
                  />
                </div>

                {/* Warning Banner */}
                <div className="p-3 bg-[#e8f8f7] dark:bg-[#25f4ee]/10 border border-[#25f4ee]/30 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-[#25f4ee] flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-[#0a9a94] dark:text-[#25f4ee]">
                        {t("tikTokDialog.labeledPromotional", "Your video will be labeled \"Promotional content\".")}
                      </p>
                      <p className="text-xs text-[#0a9a94]/80 dark:text-[#25f4ee]/80 mt-0.5">
                        {t("tikTokDialog.cannotBeChanged", "This cannot be changed once your video is posted.")}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-muted-foreground">
                  {t("tikTokDialog.discloseDescriptionFull", "Turn on to disclose that this video promotes goods or services in exchange for something of value. Your video could promote yourself, a third party, or both.")}
                </p>

                {/* Your brand checkbox - with highlight when selected */}
                <div 
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-lg transition-all cursor-pointer",
                    settings.yourBrand 
                      ? "bg-[#25f4ee]/10 border-2 border-[#25f4ee]" 
                      : "hover:bg-muted/50 border-2 border-transparent"
                  )}
                  onClick={() => onSettingsChange?.({ yourBrand: !settings.yourBrand })}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={settings.yourBrand}
                    className={cn(
                      "w-5 h-5 rounded-[4px] border-2 flex items-center justify-center transition-all flex-shrink-0 mt-0.5",
                      settings.yourBrand
                        ? "bg-[#25f4ee] border-[#25f4ee]"
                        : "border-gray-400 bg-transparent"
                    )}
                  >
                    {settings.yourBrand && <Check className="w-3.5 h-3.5 text-black" strokeWidth={3} />}
                  </button>
                  <div className="flex-1">
                    <p className="font-semibold text-sm">{t("tikTokDialog.yourBrand", "Your brand")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("tikTokDialog.yourBrandDesc", "You are promoting yourself or your own business. This video will be classified as Brand Organic.")}
                    </p>
                  </div>
                </div>

                {/* Branded content checkbox - disabled for private videos */}
                {(() => {
                  const isPrivate = settings.privacyLevel === "SELF_ONLY";
                  return (
                    <div 
                      className={cn(
                        "flex items-start gap-3 p-3 rounded-lg transition-all",
                        isPrivate 
                          ? "opacity-50 cursor-not-allowed" 
                          : "cursor-pointer",
                        settings.brandedContent && !isPrivate
                          ? "bg-[#25f4ee]/10 border-2 border-[#25f4ee]" 
                          : "border-2 border-transparent",
                        !isPrivate && !settings.brandedContent && "hover:bg-muted/50"
                      )}
                      onClick={() => !isPrivate && onSettingsChange?.({ brandedContent: !settings.brandedContent })}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={settings.brandedContent && !isPrivate}
                        disabled={isPrivate}
                        className={cn(
                          "w-5 h-5 rounded-[4px] border-2 flex items-center justify-center transition-all flex-shrink-0 mt-0.5",
                          settings.brandedContent && !isPrivate
                            ? "bg-[#25f4ee] border-[#25f4ee]"
                            : "border-gray-400 bg-transparent",
                          isPrivate && "cursor-not-allowed"
                        )}
                      >
                        {settings.brandedContent && !isPrivate && <Check className="w-3.5 h-3.5 text-black" strokeWidth={3} />}
                      </button>
                      <div className="flex-1">
                        <p className="font-semibold text-sm">{t("tikTokDialog.brandedContent", "Branded content")}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {isPrivate 
                            ? t("tikTokDialog.brandedContentPrivateDisabled", "Branded content is not available for private videos.")
                            : t("tikTokDialog.brandedContentDesc", "You are promoting another brand or a third party. This video will be classified as Branded Content.")}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Music Usage Link */}
                <p className="text-xs text-muted-foreground">
                  {t("tikTokDialog.agreePrefix", "By posting, you agree to our ")}
                  <a
                    href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#25f4ee] hover:underline"
                  >
                    {t("tikTokDialog.musicUsageConfirmation", "Music Usage Confirmation")}
                  </a>
                  .
                </p>

                {/* Upload Button for right panel */}
                <Button
                  onClick={onUpload}
                  disabled={isUploading || isDurationExceeded}
                  className="w-full h-12 bg-[#22D3EE] hover:bg-[#06B6D4] text-white font-semibold text-base disabled:opacity-50 rounded-xl"
                >
                  {isUploading ? (
                    <>
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                        className="w-5 h-5 me-2 border-2 border-white/30 border-t-white rounded-full"
                      />
                      {t("tikTokDialog.uploading", "Uploading...")}
                    </>
                  ) : scheduleEnabled ? (
                    t("tikTokDialog.schedule", "Schedule")
                  ) : (
                    t("tikTokDialog.upload", "Upload")
                  )}
                </Button>
              </motion.div>
            ) : (
              <motion.div
                key="empty-panel"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="hidden lg:block"
              />
            )}
          </AnimatePresence>
        </div>

        {/* Duration Warning */}
        {isDurationExceeded && (
          <div className="mx-6 mb-6 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-destructive">
                  {t("tikTokDialog.videoTooLong", "Video is too long")}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("tikTokDialog.videoTooLongDesc", "Your video is {{duration}} but TikTok allows a maximum of {{maxDuration}}. Please trim your video before uploading.", { duration: formatTime(duration), maxDuration: formatTime(maxDurationSec || 0) })}
                </p>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
