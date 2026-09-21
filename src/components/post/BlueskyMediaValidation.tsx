import { AlertCircle, CheckCircle2, Image, Video, FileWarning } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface MediaFile {
  previewUrl: string;
  fileType: "image" | "video";
  mimeType?: string;
  size?: number;
}

interface BlueskyMediaValidationProps {
  files: MediaFile[];
  className?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Bluesky media specifications
const BLUESKY_SPECS = {
  maxImages: 4,
  maxVideoSize: 50 * 1024 * 1024, // 50MB
  maxImageSize: 1 * 1024 * 1024, // 1MB (recommended), actual limit is higher
  supportedImageFormats: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  supportedVideoFormats: ["video/mp4", "video/webm"],
  maxVideoDuration: 60, // seconds
  maxImageDimension: 2000, // recommended pixels
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateBlueskyMedia(
  files: MediaFile[],
  t: (key: string, defaultVal: string, options?: Record<string, unknown>) => string = (
    _key,
    defaultVal,
    options
  ) => {
    if (!options) return defaultVal;
    let result = defaultVal;
    for (const [k, v] of Object.entries(options)) {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
    }
    return result;
  }
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (files.length === 0) {
    return { valid: true, errors: [], warnings: [] };
  }

  const images = files.filter(f => f.fileType === "image");
  const videos = files.filter(f => f.fileType === "video");

  // Check: Can't mix video with images
  if (videos.length > 0 && images.length > 0) {
    errors.push(t("bluesky.mixMediaError", "Bluesky doesn't support mixing videos and images in a single post. Remove either the video or images."));
  }

  // Check: Max 4 images
  if (images.length > BLUESKY_SPECS.maxImages) {
    errors.push(
      t("bluesky.maxImagesError", "Bluesky allows max {{max}} images. You have {{count}}. Remove {{excess}} image(s).", {
        max: BLUESKY_SPECS.maxImages,
        count: images.length,
        excess: images.length - BLUESKY_SPECS.maxImages,
      })
    );
  }

  // Check: Only 1 video allowed
  if (videos.length > 1) {
    errors.push(
      t("bluesky.maxVideosError", "Bluesky allows only 1 video per post. You have {{count}}. Remove {{excess}} video(s).", {
        count: videos.length,
        excess: videos.length - 1,
      })
    );
  }

  // Validate image formats
  for (const img of images) {
    if (img.mimeType && !BLUESKY_SPECS.supportedImageFormats.includes(img.mimeType)) {
      errors.push(t("bluesky.unsupportedImageFormat", "Unsupported image format: {{mime}}. Use JPEG, PNG, GIF, or WebP.", { mime: img.mimeType }));
    }
    if (img.size && img.size > BLUESKY_SPECS.maxImageSize) {
      warnings.push(t("bluesky.imageSizeWarning", "Image ({{size}}) exceeds recommended 1MB. It may be compressed.", { size: formatSize(img.size) }));
    }
  }

  // Validate video formats
  for (const vid of videos) {
    if (vid.mimeType && !BLUESKY_SPECS.supportedVideoFormats.includes(vid.mimeType)) {
      errors.push(t("bluesky.unsupportedVideoFormat", "Unsupported video format: {{mime}}. Use MP4 or WebM.", { mime: vid.mimeType }));
    }
    if (vid.size && vid.size > BLUESKY_SPECS.maxVideoSize) {
      errors.push(t("bluesky.videoSizeError", "Video ({{size}}) exceeds {{maxSize}} limit.", {
        size: formatSize(vid.size),
        maxSize: formatSize(BLUESKY_SPECS.maxVideoSize),
      }));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function BlueskyMediaValidation({ files, className }: BlueskyMediaValidationProps) {
  const { t } = useTranslation("postmedia");
  const validation = validateBlueskyMedia(files, t);

  if (files.length === 0) {
    return null;
  }

  const images = files.filter(f => f.fileType === "image");
  const videos = files.filter(f => f.fileType === "video");

  return (
    <div className={className}>
      {/* Status summary */}
      <div className="flex items-center gap-2 text-sm mb-2">
        {validation.valid ? (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        ) : (
          <AlertCircle className="w-4 h-4 text-destructive" />
        )}
        <span className="text-muted-foreground">
          {images.length > 0 && (
            <span className="inline-flex items-center gap-1 me-2">
              <Image className="w-3 h-3" />
              {t("bluesky.imagesCount", "{{count}}/{{max}} images", { count: images.length, max: BLUESKY_SPECS.maxImages })}
            </span>
          )}
          {videos.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Video className="w-3 h-3" />
              {t("bluesky.videosCount", "{{count}}/1 video", { count: videos.length })}
            </span>
          )}
        </span>
      </div>

      {/* Errors */}
      {validation.errors.length > 0 && (
        <Alert variant="destructive" className="mb-2">
          <FileWarning className="h-4 w-4" />
          <AlertTitle>{t("bluesky.issuesTitle", "Bluesky Media Issues")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside text-sm mt-1 space-y-1">
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Warnings */}
      {validation.warnings.length > 0 && validation.errors.length === 0 && (
        <Alert className="border-amber-500/50 bg-amber-500/10">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          <AlertTitle className="text-amber-600 dark:text-amber-400">{t("bluesky.recommendationsTitle", "Recommendations")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside text-sm mt-1 space-y-1">
              {validation.warnings.map((warn, i) => (
                <li key={i}>{warn}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
