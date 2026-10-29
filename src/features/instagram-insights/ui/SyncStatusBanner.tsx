import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  formatReasonExplanation,
  formatSyncStatus,
} from "../domain/formatters";
import type { OwnerReportFreshness } from "../domain/types";

export type SyncStatusBannerProps = {
  freshness: OwnerReportFreshness | undefined;
  isSyncing: boolean;
  onSync: () => void;
  disabled?: boolean;
};

export function SyncStatusBanner({
  freshness,
  isSyncing,
  onSync,
  disabled = false,
}: SyncStatusBannerProps) {
  const { t } = useTranslation("analytics");
  const status = freshness?.status ?? "never";
  const { label, variant } = formatSyncStatus(status);
  const explanation = formatReasonExplanation(freshness?.reason);

  const formattedLastSync = freshness?.lastSuccessAt
    ? new Date(freshness.lastSuccessAt).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl border border-border/70 bg-card/60 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Badge
            variant={variant === "success" ? "default" : variant === "destructive" ? "destructive" : "outline"}
            className="flex items-center gap-1.5 py-1 px-2.5 text-xs font-medium"
          >
            {status === "ok" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
            {status === "partial" && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
            {status === "error" && <AlertCircle className="h-3.5 w-3.5 text-rose-500" />}
            {status === "never" && <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
            <span>{label}</span>
          </Badge>

          {formattedLastSync && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              <span>
                {t("instagram.lastSynced", "Last synced")}: {formattedLastSync}
              </span>
            </span>
          )}

          <span className="text-xs text-muted-foreground/80 flex items-center gap-1 italic">
            <Info className="h-3 w-3 shrink-0" />
            <span>{t("instagram.lagAdvisory", "Data may lag up to 48 hours per Meta provider window.")}</span>
          </span>
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || isSyncing}
          onClick={onSync}
          className="h-8 gap-1.5 text-xs font-medium border-border/80 hover:bg-muted/70"
        >
          {isSyncing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t("instagram.syncing", "Syncing...")}</span>
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t("instagram.syncNow", "Sync now")}</span>
            </>
          )}
        </Button>
      </div>

      {explanation && (
        <Alert variant={freshness?.status === "error" ? "destructive" : "default"} className="py-2.5">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs font-medium">
            {explanation}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
