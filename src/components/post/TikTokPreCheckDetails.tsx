/**
 * TikTok Pre-Check Details Drawer
 * Shows exact detected video metadata and which rules caused warnings/failures
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HardDrive,
  Info,
  Maximize2,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";

export interface VideoCheckDetail {
  id?: string;
  label: string;
  status: "pending" | "checking" | "passed" | "warning" | "failed";
  message?: string;
  value?: string;
  detectedValue?: string | number;
  requiredValue?: string;
  rule?: string;
}

interface TikTokPreCheckDetailsProps {
  checks: VideoCheckDetail[];
  videoMetadata?: {
    width?: number;
    height?: number;
    duration?: number;
    fileSize?: number;
    format?: string;
  };
  lastCheckedAt?: Date | null;
  children?: React.ReactNode;
}

const TIKTOK_RULES = {
  format: {
    name: "Video Format",
    requirement: "MP4 or MOV",
    description: "TikTok requires videos in MP4 or MOV format.",
  },
  resolution: {
    name: "Resolution",
    requirement: "Minimum 540×960, recommended 720×1280+",
    description:
      "Videos below minimum resolution may be rejected. Higher resolutions provide better quality on the For You page.",
  },
  aspectRatio: {
    name: "Aspect Ratio",
    requirement: "9:16 (vertical)",
    description:
      "TikTok is optimized for vertical video. Horizontal videos will have black bars and lower engagement.",
  },
  duration: {
    name: "Duration",
    requirement: "Based on account's max_video_post_duration_sec",
    description:
      "Maximum duration varies by account. Check your TikTok Creator Info for your limit.",
  },
  fileSize: {
    name: "File Size",
    requirement: "500KB – 4GB",
    description: "Very small files may be corrupt. Files over 4GB cannot be uploaded.",
  },
};

export function TikTokPreCheckDetails({
  checks,
  videoMetadata,
  lastCheckedAt,
  children,
}: TikTokPreCheckDetailsProps) {
  const { t } = useTranslation("postpreview");
  const failedChecks = checks.filter((c) => c.status === "failed");
  const warningChecks = checks.filter((c) => c.status === "warning");
  const passedChecks = checks.filter((c) => c.status === "passed");

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "passed":
        return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case "warning":
        return <AlertTriangle className="w-4 h-4 text-amber-500" />;
      case "failed":
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      default:
        return <Info className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getCheckIcon = (check: VideoCheckDetail) => {
    const key = check.id || check.label.toLowerCase().replace(/\s+/g, "");
    switch (key) {
      case "format":
        return <Video className="w-4 h-4" />;
      case "resolution":
      case "aspectRatio":
      case "aspectratio":
        return <Maximize2 className="w-4 h-4" />;
      case "duration":
        return <Clock className="w-4 h-4" />;
      case "fileSize":
      case "filesize":
        return <HardDrive className="w-4 h-4" />;
      default:
        return <Info className="w-4 h-4" />;
    }
  };

  const getRuleForCheck = (check: VideoCheckDetail) => {
    const key = check.id || check.label.toLowerCase().replace(/\s+/g, "");
    switch (key) {
      case "aspectRatio":
      case "aspectratio":
        return {
          name: t("tikTokPreCheckDetails.ruleAspectName", TIKTOK_RULES.aspectRatio.name),
          requirement: t("tikTokPreCheckDetails.ruleAspectReq", TIKTOK_RULES.aspectRatio.requirement),
          description: t("tikTokPreCheckDetails.ruleAspectDesc", TIKTOK_RULES.aspectRatio.description),
        };
      case "fileSize":
      case "filesize":
        return {
          name: t("tikTokPreCheckDetails.ruleSizeName", TIKTOK_RULES.fileSize.name),
          requirement: t("tikTokPreCheckDetails.ruleSizeReq", TIKTOK_RULES.fileSize.requirement),
          description: t("tikTokPreCheckDetails.ruleSizeDesc", TIKTOK_RULES.fileSize.description),
        };
      case "format":
        return {
          name: t("tikTokPreCheckDetails.ruleFormatName", TIKTOK_RULES.format.name),
          requirement: t("tikTokPreCheckDetails.ruleFormatReq", TIKTOK_RULES.format.requirement),
          description: t("tikTokPreCheckDetails.ruleFormatDesc", TIKTOK_RULES.format.description),
        };
      case "resolution":
        return {
          name: t("tikTokPreCheckDetails.ruleResName", TIKTOK_RULES.resolution.name),
          requirement: t("tikTokPreCheckDetails.ruleResReq", TIKTOK_RULES.resolution.requirement),
          description: t("tikTokPreCheckDetails.ruleResDesc", TIKTOK_RULES.resolution.description),
        };
      case "duration":
        return {
          name: t("tikTokPreCheckDetails.ruleDurationName", TIKTOK_RULES.duration.name),
          requirement: t("tikTokPreCheckDetails.ruleDurationReq", TIKTOK_RULES.duration.requirement),
          description: t("tikTokPreCheckDetails.ruleDurationDesc", TIKTOK_RULES.duration.description),
        };
      default:
        return null;
    }
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        {children || (
          <Button variant="ghost" size="sm" className="text-xs gap-1">
            <Info className="w-3 h-3" />
            {t("tikTokPreCheckDetails.details", "Details")}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Video className="w-5 h-5" />
            {t("tikTokPreCheckDetails.title", "TikTok Pre-Check Details")}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Last Checked */}
          {lastCheckedAt && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t("tikTokPreCheckDetails.lastChecked", "Last checked")}</span>
              <span>{formatDistanceToNow(lastCheckedAt, { addSuffix: true })}</span>
            </div>
          )}

          {/* Detected Metadata */}
          {videoMetadata && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium">{t("tikTokPreCheckDetails.detectedProperties", "Detected Video Properties")}</h4>
              <div className="grid grid-cols-2 gap-3">
                {videoMetadata.width && videoMetadata.height && (
                  <div className="p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="text-xs text-muted-foreground">{t("tikTokPreCheckDetails.resolution", "Resolution")}</div>
                    <div className="font-mono text-sm font-medium">
                      {videoMetadata.width}×{videoMetadata.height}
                    </div>
                  </div>
                )}
                {videoMetadata.width && videoMetadata.height && (
                  <div className="p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="text-xs text-muted-foreground">{t("tikTokPreCheckDetails.aspectRatio", "Aspect Ratio")}</div>
                    <div className="font-mono text-sm font-medium">
                      {(videoMetadata.width / videoMetadata.height).toFixed(2)}
                      {videoMetadata.height > videoMetadata.width && t("tikTokPreCheckDetails.vertical", " (vertical)")}
                      {videoMetadata.width > videoMetadata.height && t("tikTokPreCheckDetails.horizontal", " (horizontal)")}
                    </div>
                  </div>
                )}
                {videoMetadata.duration != null && (
                  <div className="p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="text-xs text-muted-foreground">{t("tikTokPreCheckDetails.duration", "Duration")}</div>
                    <div className="font-mono text-sm font-medium">
                      {Math.floor(videoMetadata.duration / 60)}:
                      {Math.floor(videoMetadata.duration % 60)
                        .toString()
                        .padStart(2, "0")}
                    </div>
                  </div>
                )}
                {videoMetadata.fileSize != null && (
                  <div className="p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="text-xs text-muted-foreground">{t("tikTokPreCheckDetails.fileSize", "File Size")}</div>
                    <div className="font-mono text-sm font-medium">
                      {formatFileSize(videoMetadata.fileSize)}
                    </div>
                  </div>
                )}
                {videoMetadata.format && (
                  <div className="p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="text-xs text-muted-foreground">{t("tikTokPreCheckDetails.format", "Format")}</div>
                    <div className="font-mono text-sm font-medium">{videoMetadata.format}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          <Separator />

          {/* Failed Checks */}
          {failedChecks.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive" />
                <h4 className="text-sm font-medium text-destructive">
                  {t("tikTokPreCheckDetails.failedCount", { count: failedChecks.length, defaultValue: `Failed (${failedChecks.length})` })}
                </h4>
              </div>
              <div className="space-y-2">
                {failedChecks.map((check, idx) => {
                  const rule = getRuleForCheck(check);
                  return (
                    <div
                      key={idx}
                      className="p-3 rounded-lg bg-destructive/5 border border-destructive/30"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {getCheckIcon(check)}
                        <span className="font-medium text-sm">{check.label}</span>
                        {check.value && (
                          <Badge variant="outline" className="ml-auto text-xs">
                            {check.value}
                          </Badge>
                        )}
                      </div>
                      {check.message && (
                        <p className="text-xs text-destructive mb-2">{check.message}</p>
                      )}
                      {rule && (
                        <div className="text-xs text-muted-foreground bg-muted/30 p-2 rounded">
                          <strong>{t("tikTokPreCheckDetails.required", "Required:")}</strong> {rule.requirement}
                          <br />
                          {rule.description}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Warning Checks */}
          {warningChecks.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <h4 className="text-sm font-medium text-amber-600">
                  {t("tikTokPreCheckDetails.warningsCount", { count: warningChecks.length, defaultValue: `Warnings (${warningChecks.length})` })}
                </h4>
              </div>
              <div className="space-y-2">
                {warningChecks.map((check, idx) => {
                  const rule = getRuleForCheck(check);
                  return (
                    <div
                      key={idx}
                      className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/30"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {getCheckIcon(check)}
                        <span className="font-medium text-sm">{check.label}</span>
                        {check.value && (
                          <Badge variant="outline" className="ml-auto text-xs">
                            {check.value}
                          </Badge>
                        )}
                      </div>
                      {check.message && (
                        <p className="text-xs text-amber-600 mb-2">{check.message}</p>
                      )}
                      {rule && (
                        <div className="text-xs text-muted-foreground bg-muted/30 p-2 rounded">
                          <strong>{t("tikTokPreCheckDetails.recommended", "Recommended:")}</strong> {rule.requirement}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Passed Checks */}
          {passedChecks.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <h4 className="text-sm font-medium text-emerald-600">
                  {t("tikTokPreCheckDetails.passedCount", { count: passedChecks.length, defaultValue: `Passed (${passedChecks.length})` })}
                </h4>
              </div>
              <div className="space-y-2">
                {passedChecks.map((check, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/30"
                  >
                    <div className="flex items-center gap-2">
                      {getCheckIcon(check)}
                      <span className="font-medium text-sm">{check.label}</span>
                      {check.value && (
                        <Badge variant="outline" className="ml-auto text-xs">
                          {check.value}
                        </Badge>
                      )}
                    </div>
                    {check.message && (
                      <p className="text-xs text-emerald-600 mt-1">{check.message}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TikTok Requirements Reference */}
          <Separator />
          <div className="space-y-3">
            <h4 className="text-sm font-medium">{t("tikTokPreCheckDetails.rulesTitle", "TikTok Video Requirements")}</h4>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                <strong>{t("tikTokPreCheckDetails.ruleFormatName", "Format")}:</strong> {t("tikTokPreCheckDetails.ruleFormatReq", "MP4 or MOV")}
              </p>
              <p>
                <strong>{t("tikTokPreCheckDetails.ruleResName", "Resolution")}:</strong> {t("tikTokPreCheckDetails.refRes", "Minimum 540×960, recommended 720×1280 or higher")}
              </p>
              <p>
                <strong>{t("tikTokPreCheckDetails.ruleAspectName", "Aspect Ratio")}:</strong> {t("tikTokPreCheckDetails.refAspect", "9:16 (vertical) is optimal")}
              </p>
              <p>
                <strong>{t("tikTokPreCheckDetails.ruleDurationName", "Duration")}:</strong> {t("tikTokPreCheckDetails.refDuration", "Check your account's max_video_post_duration_sec")}
              </p>
              <p>
                <strong>{t("tikTokPreCheckDetails.ruleSizeName", "File Size")}:</strong> {t("tikTokPreCheckDetails.ruleSizeReq", "500KB – 4GB")}
              </p>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
