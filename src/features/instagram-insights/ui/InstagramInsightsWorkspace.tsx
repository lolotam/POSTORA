import { useTranslation } from "react-i18next";
import { AlertCircle, Instagram, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import type { SocialAccount } from "@/hooks/useSocialAccounts";
import type { OwnerReport, OwnerReportPeriodDays } from "../domain/types";
import { AccountPicker } from "./AccountPicker";
import { PeriodSelector } from "./PeriodSelector";
import { SyncStatusBanner } from "./SyncStatusBanner";
import { MetricsOverviewCards } from "./MetricsOverviewCards";
import { DailyTrendChart } from "./DailyTrendChart";
import { MediaPerformanceTable } from "./MediaPerformanceTable";

export type InstagramInsightsWorkspaceProps = {
  accounts: SocialAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (accountId: string) => void;
  periodDays: OwnerReportPeriodDays;
  onSelectPeriod: (period: OwnerReportPeriodDays) => void;
  report: OwnerReport | undefined;
  isLoading: boolean;
  error: Error | null;
  isSyncing: boolean;
  onTriggerSync: () => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
};

export function InstagramInsightsWorkspace({
  accounts,
  selectedAccountId,
  onSelectAccount,
  periodDays,
  onSelectPeriod,
  report,
  isLoading,
  error,
  isSyncing,
  onTriggerSync,
  onLoadMore,
  isLoadingMore = false,
}: InstagramInsightsWorkspaceProps) {
  const { t } = useTranslation("analytics");

  const igAccounts = accounts.filter(
    (acc) => acc.platform === "instagram" && acc.is_active !== false,
  );

  // If no account is connected
  if (igAccounts.length === 0) {
    return (
      <div className="p-8 sm:p-12 text-center rounded-2xl border border-dashed border-border bg-card/40 max-w-lg mx-auto space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-500">
          <Instagram className="h-6 w-6" />
        </div>
        <div className="space-y-1.5">
          <h3 className="font-semibold text-base">
            {t("instagram.noAccountsTitle", "Connect Your Instagram Account")}
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t(
              "instagram.noAccountsDescription",
              "Connect your Instagram Business or Creator account to unlock performance analytics, daily reach insights, and outlier scoring.",
            )}
          </p>
        </div>
        <Button asChild size="sm" className="bg-rose-600 hover:bg-rose-700 text-white font-medium">
          <Link to="/profiles">
            {t("actions.goToProfiles", "Go to Profiles")}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top controls: Account Picker + Period Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-border/70 bg-card">
        <AccountPicker
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onSelectAccount={onSelectAccount}
          disabled={isLoading || isSyncing}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t("instagram.period", "Period")}:
          </span>
          <PeriodSelector
            selectedPeriod={periodDays}
            onSelectPeriod={onSelectPeriod}
            disabled={isLoading}
          />
        </div>
      </div>

      {/* Sync Status Banner */}
      <SyncStatusBanner
        freshness={report?.freshness}
        isSyncing={isSyncing}
        onSync={onTriggerSync}
        disabled={isLoading || !selectedAccountId}
      />

      {/* Error State */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="text-xs font-semibold">{t("errors.failedToLoad", "Failed to load report")}</AlertTitle>
          <AlertDescription className="text-xs mt-1">
            {error.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Loading Skeleton */}
      {isLoading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      )}

      {/* Data Visualizations */}
      {!isLoading && report && (
        <>
          <MetricsOverviewCards report={report} />
          <DailyTrendChart daily={report.daily} />
          <MediaPerformanceTable
            media={report.media}
            onLoadMore={onLoadMore}
            isLoadingMore={isLoadingMore}
          />
        </>
      )}
    </div>
  );
}
