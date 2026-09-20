import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Image, Video, Upload, Loader2, ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Platform } from "@/lib/types";
import { UploadedFile } from "@/hooks/usePostForm";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { ImageAspectRatioValidator, AspectRatioSuggestion } from "./ImageAspectRatioValidator";
import { SortableMediaItem } from "./SortableMediaItem";
import { MediaLightbox } from "./MediaLightbox";
import { PlatformCompatibilityTooltip } from "./PlatformCompatibilityTooltip";
import { MediaAnalysis } from "@/lib/mediaAnalyzer";
import { PlatformEligibility } from "@/lib/platformEligibility";
import { Icon3D, GradientRingCard } from "@/components/fx";

type UploadMethod = "local" | "url" | "text";

interface MediaUploadAreaProps {
  uploadMethod: UploadMethod;
  files: UploadedFile[];
  isDragging: boolean;
  isUploading: boolean;
  selectedPlatforms: Platform[];
  urlMediaType: "images" | "video";
  setUrlMediaType: (type: "images" | "video") => void;
  imageUrls: string;
  setImageUrls: (urls: string) => void;
  videoUrl: string;
  setVideoUrl: (url: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileSelect: (fileList: FileList) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onRemoveFile: (id: string) => void;
  onOpenCropper: (file: UploadedFile, targetRatio?: string) => void;
  onOpenCompressor: (file: UploadedFile) => void;
  onImageCropRequest: (suggestion: AspectRatioSuggestion) => void;
  onReorderFiles: (files: UploadedFile[]) => void;
  // NEW: Media analysis and eligibility
  mediaAnalysis?: MediaAnalysis;
  platformEligibility?: PlatformEligibility[];
  allPlatforms?: Platform[];
}

export function MediaUploadArea({
  uploadMethod,
  files,
  isDragging,
  isUploading,
  selectedPlatforms,
  urlMediaType,
  setUrlMediaType,
  imageUrls,
  setImageUrls,
  videoUrl,
  setVideoUrl,
  fileInputRef,
  onFileSelect,
  onDragOver,
  onDragLeave,
  onDrop,
  onRemoveFile,
  onOpenCropper,
  onOpenCompressor,
  onImageCropRequest,
  onReorderFiles,
  mediaAnalysis,
  platformEligibility,
  allPlatforms,
}: MediaUploadAreaProps) {
  const { t } = useTranslation("postmedia");
  const { flags, isLoading: isFlagsLoading } = useFeatureFlags();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  
  const MAX_FILES = 10;
  const remainingSlots = MAX_FILES - files.length;
  const isAtLimit = files.length >= MAX_FILES;
  
  // Check if first file is a video - if so, disable multiple uploads
  const firstFileIsVideo = files.length > 0 && files[0].fileType === "video";
  const shouldDisableMultiple = firstFileIsVideo || isAtLimit;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = files.findIndex((f) => f.id === active.id);
      const newIndex = files.findIndex((f) => f.id === over.id);
      const newFiles = arrayMove(files, oldIndex, newIndex);
      onReorderFiles(newFiles);
    }
  };
  if (uploadMethod === "text") return null;

  if (uploadMethod === "url") {
    return (
      <div className="space-y-4">
        <Label className="text-sm">{t("uploadArea.mediaUrls", "Media URLs")}</Label>
        <GradientRingCard variant="violet" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-4">
          <Tabs value={urlMediaType} onValueChange={(v) => setUrlMediaType(v as "images" | "video")}>
            <TabsList className={cn(
              "mb-4 bg-card/50 backdrop-blur-md border border-border/40 rounded-xl p-1",
              "[&>[data-state=active]]:bg-gradient-to-r [&>[data-state=active]]:from-violet-500 [&>[data-state=active]]:via-fuchsia-500 [&>[data-state=active]]:to-sky-500 [&>[data-state=active]]:text-white [&>[data-state=active]]:shadow-md [&>[data-state=active]]:shadow-violet-500/30"
            )}>
              <TabsTrigger value="images" className="gap-2">
                <Image className="w-4 h-4" />
                {t("uploadArea.tabImages", "Images")}
              </TabsTrigger>
              <TabsTrigger value="video" className="gap-2">
                <Video className="w-4 h-4" />
                {t("uploadArea.tabVideo", "Video")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="images">
              <Input
                placeholder={t("uploadArea.imageUrlsPlaceholder", "Enter image URLs (one per line, max 10)")}
                value={imageUrls}
                onChange={(e) => setImageUrls(e.target.value)}
                className="min-h-[80px] bg-background/60 backdrop-blur-sm border-violet-400/30 focus-visible:border-violet-400 focus-visible:ring-violet-400/30"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("uploadArea.imageUrlsHint", "Enter direct image URLs, one per line")}
              </p>
            </TabsContent>
            <TabsContent value="video">
              <Input
                placeholder={t("uploadArea.videoUrlPlaceholder", "Enter video URL")}
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                className="bg-background/60 backdrop-blur-sm border-violet-400/30 focus-visible:border-violet-400 focus-visible:ring-violet-400/30"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("uploadArea.videoUrlHint", "Enter a direct video URL (MP4, MOV)")}
              </p>
            </TabsContent>
          </Tabs>
        </GradientRingCard>
      </div>
    );
  }

  // Local upload method
  return (
    <div className="space-y-4">
      <Label className="text-sm">{t("uploadArea.mediaLabel", "Media")}</Label>
      <div
        className={cn(
          "border-2 border-dashed rounded-2xl p-6 text-center transition-all duration-300 backdrop-blur-sm",
          isDragging
            ? "border-violet-400 bg-gradient-to-br from-violet-500/10 via-fuchsia-500/5 to-transparent shadow-lg shadow-violet-500/30 scale-[1.01]"
            : "border-violet-400/40 bg-card/40 hover:border-violet-400/70 hover:bg-card/60 hover:shadow-md hover:shadow-violet-500/20"
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple={!firstFileIsVideo}
          onChange={(e) => e.target.files && onFileSelect(e.target.files)}
          className="hidden"
        />
        <div className="group flex flex-col items-center gap-3">
          <Icon3D icon={Upload} variant="violet" size="md" />
          <p className="text-base font-semibold bg-clip-text text-transparent bg-gradient-to-r from-violet-500 via-fuchsia-500 to-sky-500">
            {t("uploadArea.dragDropTitle", "Drag and drop your media here")}
          </p>
          <p className="text-xs text-muted-foreground">
            {firstFileIsVideo 
              ? t("uploadArea.videoLimitNotice", "Video uploaded - only one video per post allowed") 
              : t("uploadArea.browseHint", "or click to browse (max {{max}} files, up to 100MB each)", { max: MAX_FILES })}
          </p>
          {/* Hide upload button when first file is video */}
          {!firstFileIsVideo && (
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || isAtLimit}
              className={cn(
                "border-0 text-white shadow-md transition-all",
                isAtLimit
                  ? "bg-muted text-muted-foreground"
                  : "bg-gradient-to-r from-violet-500 via-fuchsia-500 to-sky-500 shadow-violet-500/30 hover:shadow-lg hover:shadow-violet-500/50 hover:opacity-95"
              )}
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("uploadArea.uploading", "Uploading...")}
                </>
              ) : isAtLimit ? (
                t("uploadArea.limitReached", "Limit Reached")
              ) : (
                t("uploadArea.selectFiles", "Select Files")
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Remaining slots indicator + Compatibility tooltip */}
      {files.length > 0 && flags.mediaCounter && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <ImagePlus className="w-4 h-4" />
            <span>
              {t("uploadArea.mediaCounter", "{{count}} of {{max}} media added", { count: files.length, max: MAX_FILES })}
            </span>
            {/* Platform compatibility tooltip */}
            {mediaAnalysis && platformEligibility && allPlatforms && allPlatforms.length > 0 && (
              <PlatformCompatibilityTooltip
                mediaAnalysis={mediaAnalysis}
                platformEligibility={platformEligibility}
                allPlatforms={allPlatforms}
              />
            )}
          </div>
          <div className="flex gap-1">
            {Array.from({ length: MAX_FILES }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "w-2 h-2 rounded-full transition-all duration-300",
                  i < files.length
                    ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-sm shadow-violet-500/50"
                    : "bg-muted-foreground/30"
                )}
              />
            ))}
          </div>
        </div>
      )}

      {/* File previews with drag and drop reordering */}
      {files.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={files.map((f) => f.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex flex-wrap gap-3 animate-fade-in">
              {files.map((file, index) => {
                // Calculate size variant based on total file count
                const count = files.length;
                let sizeVariant: "full" | "half" | "third" | "quarter" | "compact" = "full";
                if (count === 1) sizeVariant = "full";
                else if (count === 2) sizeVariant = "half";
                else if (count === 3) sizeVariant = "third";
                else if (count <= 4) sizeVariant = "quarter";
                else sizeVariant = "compact";

                return (
                  <SortableMediaItem
                    key={file.id}
                    file={file}
                    selectedPlatforms={selectedPlatforms}
                    onRemove={onRemoveFile}
                    onOpenCropper={onOpenCropper}
                    onOpenCompressor={onOpenCompressor}
                    onOpenLightbox={() => setLightboxIndex(index)}
                    sizeVariant={sizeVariant}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Lightbox */}
      <MediaLightbox
        files={files}
        currentIndex={lightboxIndex ?? 0}
        isOpen={lightboxIndex !== null}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
        selectedPlatforms={selectedPlatforms}
      />

      {/* Image Aspect Ratio Validator (requires Image Crop feature) */}
      {!isFlagsLoading && flags.imageCrop && files.some(f => f.fileType === "image") && selectedPlatforms.length > 0 && (
        <ImageAspectRatioValidator
          imageSrc={files.find(f => f.fileType === "image")?.previewUrl || ""}
          selectedPlatforms={selectedPlatforms}
          onCropRequest={onImageCropRequest}
        />
      )}
    </div>
  );
}
