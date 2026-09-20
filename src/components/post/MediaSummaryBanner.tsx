import { Image, Video, FileImage, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MediaAnalysis } from "@/lib/mediaAnalyzer";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface MediaSummaryBannerProps {
  analysis: MediaAnalysis;
  eligibleCount: number;
  totalPlatforms: number;
  className?: string;
}

export function MediaSummaryBanner({
  analysis,
  eligibleCount,
  totalPlatforms,
  className,
}: MediaSummaryBannerProps) {
  const { t } = useTranslation("postmedia");

  if (analysis.isTextOnly) {
    return null;
  }

  const parts: string[] = [];
  if (analysis.imageCount > 0) {
    parts.push(t("summary.photosCount", "{{count}} photos", { count: analysis.imageCount }));
  }
  if (analysis.videoCount > 0) {
    parts.push(t("summary.videosCount", "{{count}} videos", { count: analysis.videoCount }));
  }
  if (analysis.gifCount > 0) {
    parts.push(t("summary.gifsCount", "{{count}} GIFs", { count: analysis.gifCount }));
  }
  const description = parts.length > 0 ? parts.join(t("summary.separator", ", ")) : t("summary.textOnly", "Text only");
  const hasRestrictions = eligibleCount < totalPlatforms;

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border",
        hasRestrictions
          ? "bg-amber-500/10 border-amber-500/30"
          : "bg-muted/50 border-border",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {analysis.hasImages && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Image className="w-4 h-4" />
            <span className="text-xs font-medium">{analysis.imageCount}</span>
          </div>
        )}
        {analysis.hasVideos && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Video className="w-4 h-4" />
            <span className="text-xs font-medium">{analysis.videoCount}</span>
          </div>
        )}
        {analysis.hasGifs && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <FileImage className="w-4 h-4" />
            <span className="text-xs font-medium">{analysis.gifCount}</span>
          </div>
        )}
      </div>

      <div className="h-4 w-px bg-border" />

      <span className="text-sm text-muted-foreground flex-1">
        {description}
      </span>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded",
                hasRestrictions
                  ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                  : "bg-primary/10 text-primary"
              )}
            >
              {hasRestrictions && <Info className="w-3 h-3" />}
              <span>
                {t("summary.platformsCount", "{{eligible}}/{{total}} platforms", { eligible: eligibleCount, total: totalPlatforms })}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[250px]">
            <p className="text-xs">
              {hasRestrictions
                ? t("summary.unsupportedNotice", "{{count}} platform(s) don't support this media combination.", { count: totalPlatforms - eligibleCount })
                : t("summary.allSupported", "All connected platforms support this media type.")}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
