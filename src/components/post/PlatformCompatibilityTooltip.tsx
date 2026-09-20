import { Info, Check, X, AlertTriangle } from "lucide-react";
import { Platform } from "@/lib/types";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { platformMediaSupport, platformDisplayNames } from "@/lib/platformMediaSupport";
import { MediaAnalysis } from "@/lib/mediaAnalyzer";
import { PlatformEligibility } from "@/lib/platformEligibility";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface PlatformCompatibilityTooltipProps {
  mediaAnalysis: MediaAnalysis;
  platformEligibility: PlatformEligibility[];
  allPlatforms: Platform[];
  className?: string;
}

export function PlatformCompatibilityTooltip({
  mediaAnalysis,
  platformEligibility,
  allPlatforms,
  className,
}: PlatformCompatibilityTooltipProps) {
  const { t } = useTranslation("postpreview");
  const eligibleCount = platformEligibility.filter(e => e.isEligible).length;
  const hasRestrictions = eligibleCount < allPlatforms.length;

  // Group by eligibility
  const eligible = platformEligibility.filter(e => e.isEligible && !e.warningReason);
  const withWarnings = platformEligibility.filter(e => e.isEligible && e.warningReason);
  const ineligible = platformEligibility.filter(e => !e.isEligible);

  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 text-xs font-normal",
            hasRestrictions
              ? "text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300"
              : "text-muted-foreground hover:text-foreground",
            className
          )}
        >
          <Info className="w-3.5 h-3.5" />
          {t("platformCompatibility.button", { eligible: eligibleCount, total: allPlatforms.length, defaultValue: `${eligibleCount}/${allPlatforms.length} platforms` })}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 p-0">
        <div className="p-3 border-b border-border">
          <h4 className="font-semibold text-sm">{t("platformCompatibility.title", "Platform Compatibility")}</h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t("platformCompatibility.subtitle", "Based on your current media selection")}
          </p>
        </div>

        <div className="max-h-[300px] overflow-y-auto">
          {/* Eligible platforms */}
          {eligible.length > 0 && (
            <div className="p-3 border-b border-border/50">
              <p className="text-xs font-medium text-green-600 dark:text-green-400 mb-2 flex items-center gap-1">
                <Check className="w-3 h-3" />
                {t("platformCompatibility.fullyCompatible", { count: eligible.length, defaultValue: `Fully Compatible (${eligible.length})` })}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {eligible.map(({ platform }) => (
                  <div
                    key={platform}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-green-500/10 text-xs"
                  >
                    <PlatformIcon platform={platform} size="xs" />
                    <span>{getPlatformName(platform)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* With warnings */}
          {withWarnings.length > 0 && (
            <div className="p-3 border-b border-border/50">
              <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {t("platformCompatibility.withLimitations", { count: withWarnings.length, defaultValue: `With Limitations (${withWarnings.length})` })}
              </p>
              <div className="space-y-1.5">
                {withWarnings.map(({ platform, warningReason }) => (
                  <div
                    key={platform}
                    className="flex items-center justify-between px-2 py-1.5 rounded bg-amber-500/10 text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      <PlatformIcon platform={platform} size="xs" />
                      <span>{getPlatformName(platform)}</span>
                    </div>
                    <span className="text-amber-600 dark:text-amber-400 text-[10px]">
                      {warningReason}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ineligible */}
          {ineligible.length > 0 && (
            <div className="p-3">
              <p className="text-xs font-medium text-destructive/80 mb-2 flex items-center gap-1">
                <X className="w-3 h-3" />
                {t("platformCompatibility.notCompatible", { count: ineligible.length, defaultValue: `Not Compatible (${ineligible.length})` })}
              </p>
              <div className="space-y-1.5">
                {ineligible.map(({ platform, reason }) => (
                  <div
                    key={platform}
                    className="flex items-center justify-between px-2 py-1.5 rounded bg-destructive/10 text-xs opacity-70"
                  >
                    <div className="flex items-center gap-1.5">
                      <PlatformIcon platform={platform} size="xs" />
                      <span>{getPlatformName(platform)}</span>
                    </div>
                    <span className="text-destructive text-[10px]">
                      {reason}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-border bg-muted/30">
          <Link to="/docs/media-matrix">
            <Button variant="ghost" size="sm" className="w-full text-xs h-7">
              {t("platformCompatibility.viewMatrix", "View full compatibility matrix")}
            </Button>
          </Link>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
