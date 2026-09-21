import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  Trash2,
  RefreshCw,
  Download,
  Loader2,
  RotateCw,
  Send,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GradientRingCard, Icon3D } from "@/components/fx";
import { useTranslation } from "react-i18next";

interface HistoryHeaderProps {
  paginatedCount: number;
  selectedCount: number;
  failedCount: number;
  isAllSelected: boolean;
  bulkRetrying: boolean;
  bulkRetryProgress: { current: number; total: number };
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onBulkDelete: () => void;
  onBulkRetry: () => void;
  onExport: (format: "csv" | "json") => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function HistoryHeader({
  paginatedCount,
  selectedCount,
  failedCount,
  isAllSelected,
  bulkRetrying,
  bulkRetryProgress,
  onSelectAll,
  onDeselectAll,
  onBulkDelete,
  onBulkRetry,
  onExport,
  onRefresh,
  isRefreshing,
}: HistoryHeaderProps) {
  const { t } = useTranslation("history");

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4" data-testid="history-header">
        <div className="flex items-center gap-4">
          <Icon3D icon={Send} variant="emerald" size="md" />
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight" data-testid="history-title">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-emerald-500 via-cyan-500 to-sky-500">
                {t("header.title", "Post History")}
              </span>
            </h1>
            <p className="text-muted-foreground mt-1">
              {t("header.subtitle", "View and manage all your published posts.")}
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap items-center rounded-2xl border border-border/60 bg-card/60 backdrop-blur-md p-2" data-testid="bulk-actions">
          {onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing} className="gap-2">
              <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {t("common:refresh", "Refresh")}
            </Button>
          )}
          {/* Bulk Selection Controls */}
          {paginatedCount > 0 && (
            <>
              {isAllSelected ? (
                <Button variant="outline" size="sm" onClick={onDeselectAll} data-testid="deselect-all-btn">
                  {t("header.deselectAll", "Deselect All")}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={onSelectAll} data-testid="select-all-btn">
                  <CheckCircle2 className="w-4 h-4 me-2" />
                  {t("header.selectAll", "Select All ({{count}})", { count: paginatedCount })}
                </Button>
              )}
            </>
          )}
          {selectedCount > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onBulkDelete}
              className="gap-2"
              data-testid="bulk-delete-btn"
            >
              <Trash2 className="w-4 h-4" />
              {t("header.deleteSelected", "Delete ({{count}})", { count: selectedCount })}
            </Button>
          )}
          {failedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={onBulkRetry}
              disabled={bulkRetrying}
              className="gap-2"
              data-testid="retry-all-failed-btn"
            >
              {bulkRetrying ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {t("header.retryAllFailed", "Retry All Failed ({{count}})", { count: failedCount })}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" data-testid="export-btn">
                <Download className="w-4 h-4" />
                {t("header.export", "Export")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="export-menu">
              <DropdownMenuItem onClick={() => onExport("csv")} data-testid="export-csv">
                {t("header.exportCsv", "Export as CSV")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("json")} data-testid="export-json">
                {t("header.exportJson", "Export as JSON")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Bulk Retry Progress */}
      {bulkRetrying && (
        <GradientRingCard variant="amber" padded={false} innerClassName="p-4 animate-fade-in">
          <div className="flex items-center gap-3" data-testid="bulk-retry-progress">
            <Icon3D icon={RotateCw} variant="amber" size="sm" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{t("header.retryingFailed", "Retrying failed posts...")}</span>
                <span className="text-muted-foreground">
                  {bulkRetryProgress.current} / {bulkRetryProgress.total}
                </span>
              </div>
              <Progress
                value={(bulkRetryProgress.current / bulkRetryProgress.total) * 100}
                className="h-2"
              />
            </div>
          </div>
        </GradientRingCard>
      )}
    </>
  );
}
