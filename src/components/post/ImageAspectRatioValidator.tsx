import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Crop } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageAspectRatioValidatorProps {
  imageSrc: string;
  selectedPlatforms: string[];
  onCropRequest?: (suggestion: AspectRatioSuggestion) => void;
  className?: string;
}

export interface AspectRatioSuggestion {
  platform: string;
  isValid: boolean;
  currentRatio: number;
  currentDimensions: { width: number; height: number };
  recommendedRatio: string;
  targetDimensions: { width: number; height: number };
  cropDirection: "width" | "height" | null;
}

// Platform-specific aspect ratio requirements for images
const PLATFORM_IMAGE_RATIOS: Record<string, {
  ratios: { value: string; label: string; min: number; max: number }[];
  recommended: string;
}> = {
  instagram: {
    ratios: [
      { value: "1:1", label: "Square", min: 0.95, max: 1.05 },
      { value: "4:5", label: "Portrait", min: 0.75, max: 0.85 },
      { value: "1.91:1", label: "Landscape", min: 1.85, max: 1.95 },
    ],
    recommended: "1:1",
  },
  facebook: {
    ratios: [
      { value: "1:1", label: "Square", min: 0.95, max: 1.05 },
      { value: "4:5", label: "Portrait", min: 0.75, max: 0.85 },
      { value: "16:9", label: "Landscape", min: 1.7, max: 1.85 },
      { value: "1.91:1", label: "Link Preview", min: 1.85, max: 1.95 },
    ],
    recommended: "1:1",
  },
  twitter: {
    ratios: [
      { value: "16:9", label: "Landscape", min: 1.7, max: 1.85 },
      { value: "1:1", label: "Square", min: 0.95, max: 1.05 },
      { value: "2:1", label: "Header", min: 1.9, max: 2.1 },
    ],
    recommended: "16:9",
  },
  linkedin: {
    ratios: [
      { value: "1.91:1", label: "Link Preview", min: 1.85, max: 1.95 },
      { value: "1:1", label: "Square", min: 0.95, max: 1.05 },
      { value: "4:5", label: "Portrait", min: 0.75, max: 0.85 },
    ],
    recommended: "1.91:1",
  },
  pinterest: {
    ratios: [
      { value: "2:3", label: "Vertical", min: 0.6, max: 0.7 },
      { value: "1:1", label: "Square", min: 0.95, max: 1.05 },
      { value: "1:2.1", label: "Tall", min: 0.45, max: 0.5 },
    ],
    recommended: "2:3",
  },
  tiktok: {
    ratios: [
      { value: "9:16", label: "Vertical", min: 0.5, max: 0.6 },
      { value: "1:1", label: "Square", min: 0.95, max: 1.05 },
    ],
    recommended: "9:16",
  },
  youtube: {
    ratios: [
      { value: "16:9", label: "Thumbnail", min: 1.7, max: 1.85 },
    ],
    recommended: "16:9",
  },
};

function parseRatio(ratioStr: string): number {
  const parts = ratioStr.split(":").map(Number);
  return parts[0] / parts[1];
}

function validateImageAspectRatio(
  width: number,
  height: number,
  platforms: string[]
): AspectRatioSuggestion[] {
  const currentRatio = width / height;
  const suggestions: AspectRatioSuggestion[] = [];

  for (const platform of platforms) {
    const spec = PLATFORM_IMAGE_RATIOS[platform.toLowerCase()];
    if (!spec) continue;

    let isValid = false;
    let matchedRatio = "";

    for (const ratio of spec.ratios) {
      if (currentRatio >= ratio.min && currentRatio <= ratio.max) {
        isValid = true;
        matchedRatio = ratio.value;
        break;
      }
    }

    const recommendedRatio = spec.recommended;
    const targetRatio = parseRatio(recommendedRatio);

    let targetWidth = width;
    let targetHeight = height;
    let cropDirection: "width" | "height" | null = null;

    if (!isValid) {
      if (currentRatio > targetRatio) {
        // Too wide - crop width
        targetWidth = Math.round(height * targetRatio);
        targetHeight = height;
        cropDirection = "width";
      } else {
        // Too tall - crop height
        targetWidth = width;
        targetHeight = Math.round(width / targetRatio);
        cropDirection = "height";
      }
    }

    suggestions.push({
      platform: platform.charAt(0).toUpperCase() + platform.slice(1),
      isValid,
      currentRatio,
      currentDimensions: { width, height },
      recommendedRatio: matchedRatio || recommendedRatio,
      targetDimensions: { width: targetWidth, height: targetHeight },
      cropDirection,
    });
  }

  return suggestions;
}

export function ImageAspectRatioValidator({
  imageSrc,
  selectedPlatforms,
  onCropRequest,
  className,
}: ImageAspectRatioValidatorProps) {
  const { t } = useTranslation("postmedia");
  const [suggestions, setSuggestions] = useState<AspectRatioSuggestion[]>([]);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!imageSrc) return;

    const img = new Image();
    img.onload = () => {
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = imageSrc;
  }, [imageSrc]);

  useEffect(() => {
    if (imageDimensions && selectedPlatforms.length > 0) {
      const validations = validateImageAspectRatio(
        imageDimensions.width,
        imageDimensions.height,
        selectedPlatforms
      );
      setSuggestions(validations);
    } else {
      setSuggestions([]);
    }
  }, [imageDimensions, selectedPlatforms]);

  if (suggestions.length === 0) return null;

  const hasIssues = suggestions.some((s) => !s.isValid);

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs font-medium text-muted-foreground">{t("aspectRatioValidator.title", "Image Aspect Ratio Check")}</p>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((suggestion) => (
          <div
            key={suggestion.platform}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-xs",
              suggestion.isValid
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            )}
          >
            {suggestion.isValid ? (
              <CheckCircle2 className="w-3 h-3" />
            ) : (
              <AlertTriangle className="w-3 h-3" />
            )}
            <span className="font-medium">{suggestion.platform}</span>
            {!suggestion.isValid && (
              <>
                <span className="text-muted-foreground">
                  {t("aspectRatioValidator.cropTo", "→ Crop to {{width}}×{{height}} ({{ratio}})", {
                    width: suggestion.targetDimensions.width,
                    height: suggestion.targetDimensions.height,
                    ratio: suggestion.recommendedRatio,
                  })}
                </span>
                {onCropRequest && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1 ml-1"
                    onClick={() => onCropRequest(suggestion)}
                  >
                    <Crop className="w-3 h-3" />
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      
      {hasIssues && onCropRequest && (
        <p className="text-xs text-muted-foreground">
          {t("aspectRatioValidator.hint", "Click the crop icon to automatically adjust the image for optimal display")}
        </p>
      )}
    </div>
  );
}

export { PLATFORM_IMAGE_RATIOS, validateImageAspectRatio };
