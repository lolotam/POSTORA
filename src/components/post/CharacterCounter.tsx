import { useTranslation } from "react-i18next";
import { Platform } from "@/lib/types";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CharacterCounterProps {
  caption: string;
  selectedPlatforms: Platform[];
}

const platformLimits: Record<Platform, number> = {
  facebook: 63206,
  instagram: 2200,
  tiktok: 4000,
  twitter: 280,
  linkedin: 3000,
  pinterest: 500,
  youtube: 5000,
  threads: 500,
  bluesky: 300,
  reddit: 40000,
  whatsapp: 4096,
};

export function CharacterCounter({ caption, selectedPlatforms }: CharacterCounterProps) {
  const { t } = useTranslation("post");
  const length = caption.length;

  if (selectedPlatforms.length === 0) {
    return null;
  }

  // Check if any platform is over limit
  const hasOverLimit = selectedPlatforms.some(p => length > platformLimits[p]);

  return (
    <div className="flex flex-wrap gap-2">
      {selectedPlatforms.map((platform) => {
        const limit = platformLimits[platform];
        const percentage = (length / limit) * 100;
        const isOverLimit = length > limit;
        const isNearLimit = percentage >= 90 && !isOverLimit;
        const overBy = length - limit;

        return (
          <TooltipProvider key={platform}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-default",
                    isOverLimit
                      ? "bg-destructive/10 text-destructive border border-destructive/50 animate-pulse"
                      : isNearLimit
                      ? "bg-amber-500/10 text-amber-600 border border-amber-500/30"
                      : "bg-secondary text-muted-foreground border border-border"
                  )}
                >
                  <PlatformIcon platform={platform} size="xs" />
                  <span className="hidden sm:inline">{getPlatformName(platform)}</span>
                  <span className={cn("font-mono", isOverLimit && "font-bold")}>
                    {length.toLocaleString()}/{limit.toLocaleString()}
                  </span>
                  {isOverLimit ? (
                    <AlertTriangle className="w-3 h-3 animate-bounce" />
                  ) : isNearLimit ? (
                    <AlertTriangle className="w-3 h-3" />
                  ) : (
                    <CheckCircle className="w-3 h-3 opacity-50" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {isOverLimit ? (
                  <p className="text-destructive font-medium">
                    {t("charCounter.overLimit", "{{count}} characters over the {{platform}} limit!", {
                      count: overBy,
                      platform: getPlatformName(platform),
                    })}
                  </p>
                ) : isNearLimit ? (
                  <p className="text-amber-600">
                    {t("charCounter.nearLimit", "Approaching {{platform}} character limit ({{percent}}%)", {
                      platform: getPlatformName(platform),
                      percent: Math.round(percentage),
                    })}
                  </p>
                ) : (
                  <p>
                    {t("charCounter.remaining", "{{count}} characters remaining for {{platform}}", {
                      count: limit - length,
                      platform: getPlatformName(platform),
                    })}
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}
