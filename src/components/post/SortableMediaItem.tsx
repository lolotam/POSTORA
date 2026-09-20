import { useSortable } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GripVertical, CheckCircle2, Loader2, Crop, Shrink, X, Maximize2, FileText } from "lucide-react";
import { UploadedFile } from "@/hooks/usePostForm";
import { VideoPreview, checkFileSizeForPlatforms } from "./VideoPreview";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";

interface SortableMediaItemProps {
  file: UploadedFile;
  selectedPlatforms: Platform[];
  onRemove: (id: string) => void;
  onOpenCropper: (file: UploadedFile) => void;
  onOpenCompressor: (file: UploadedFile) => void;
  onOpenLightbox: () => void;
  onEditAltText?: (file: UploadedFile) => void;
  /** Size variant based on total count */
  sizeVariant?: "full" | "half" | "third" | "quarter" | "compact";
}

export function SortableMediaItem({
  file,
  selectedPlatforms,
  onRemove,
  onOpenCropper,
  onOpenCompressor,
  onOpenLightbox,
  onEditAltText,
  sizeVariant = "full",
}: SortableMediaItemProps) {
  const { t } = useTranslation("postmedia");
  const { flags } = useFeatureFlags();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const effectiveFileType = file.fileType === "gif" ? "image" : file.fileType;
  // Handle external URL files (KLIPY, Pexels, Pixabay) that don't have a real File object
  const fileSize = file.file?.size || 0;
  const sizeCheck = file.uploaded && selectedPlatforms.length > 0 && fileSize > 0
    ? checkFileSizeForPlatforms(fileSize, effectiveFileType, selectedPlatforms)
    : null;

  const isImageOrGif = file.fileType === "image" || file.fileType === "gif";

  // Dynamic max-height based on size variant
  const sizeClasses = {
    full: "max-h-[400px]",
    half: "max-h-[280px]",
    third: "max-h-[200px]",
    quarter: "max-h-[160px]",
    compact: "max-h-[120px]",
  };

  const containerSizeClasses = {
    full: "w-full",
    half: "w-[calc(50%-6px)]",
    third: "w-[calc(33.333%-8px)]",
    quarter: "w-[calc(25%-9px)]",
    compact: "w-[calc(20%-10px)]",
  };

  const maxHeightClass = sizeClasses[sizeVariant];
  const containerWidthClass = containerSizeClasses[sizeVariant];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative group rounded-lg overflow-hidden bg-muted bg-black/5 dark:bg-white/5 flex-shrink-0 transition-all duration-300 ease-out",
        containerWidthClass,
        isDragging && "opacity-50 z-50 scale-105"
      )}
    >
      {/* Drag handle */}
      {file.uploaded && (
        <div
          {...attributes}
          {...listeners}
          className="absolute top-2 left-2 z-20 bg-black/60 rounded p-1 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <GripVertical className="w-4 h-4 text-white" />
        </div>
      )}

      {/* Alt text indicator */}
      {file.uploaded && isImageOrGif && file.altText && (
        <div className="absolute top-2 left-10 z-20 bg-blue-500/90 rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-[10px] text-white font-medium">ALT</span>
        </div>
      )}

      {/* Media content */}
      {file.fileType === "video" ? (
        <VideoPreview
          src={file.previewUrl}
          selectedPlatforms={selectedPlatforms}
          className={cn(maxHeightClass, "w-full object-contain transition-all duration-300")}
        />
      ) : (
        <img
          src={file.previewUrl}
          alt={file.altText || t("sortable.previewAlt", "Preview")}
          className={cn(maxHeightClass, "w-full object-contain cursor-pointer transition-all duration-300")}
          onClick={onOpenLightbox}
        />
      )}

      {/* Size warnings */}
      {sizeCheck && !sizeCheck.valid && sizeCheck.warnings.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/70 to-transparent">
          <div className="flex flex-wrap gap-1">
            {sizeCheck.warnings.map((warning, idx) => (
              <Badge key={idx} variant="destructive" className="text-[10px] px-1 py-0">
                {warning}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {file.uploaded ? (
        <>
          <div className="absolute top-2 right-2 bg-green-500/90 rounded-full p-1">
            <CheckCircle2 className="w-4 h-4 text-white" />
          </div>
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 flex-wrap p-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-8"
              onClick={onOpenLightbox}
            >
              <Maximize2 className="w-4 h-4 mr-1" />
              {t("sortable.view", "View")}
            </Button>
            {isImageOrGif && onEditAltText && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={() => onEditAltText(file)}
              >
                <FileText className="w-4 h-4 mr-1" />
                {t("sortable.alt", "Alt")}
              </Button>
            )}
            {file.fileType === "image" && flags.imageCrop && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={() => onOpenCropper(file)}
              >
                <Crop className="w-4 h-4 mr-1" />
                {t("sortable.crop", "Crop")}
              </Button>
            )}
            {/* GIF cropping disabled - GIFs don't support cropping (breaks animation) */}
            {/* Video crop - uses server-side Cloudinary processing */}
            {file.fileType === "video" && flags.imageCrop && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={() => onOpenCropper(file)}
              >
                <Crop className="w-4 h-4 mr-1" />
                {t("sortable.crop", "Crop")}
              </Button>
            )}
            {file.fileType === "video" && flags.videoCompress && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={() => onOpenCompressor(file)}
              >
                <Shrink className="w-4 h-4 mr-1" />
                {t("sortable.compress", "Compress")}
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              className="h-8"
              onClick={() => onRemove(file.id)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </>
      ) : (
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-white mb-1" />
          <span className="text-xs text-white">{Math.round(file.uploadProgress)}%</span>
        </div>
      )}
    </div>
  );
}
