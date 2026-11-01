import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import type { InstagramInsightsGateway } from "../application/ports";
import { useInstagramInsightsReport } from "../application/useInstagramInsightsReport";
import { useTriggerInstagramSync } from "../application/useTriggerInstagramSync";
import { defaultInstagramInsightsGateway } from "../infrastructure/supabaseInstagramInsightsGateway";
import type { OwnerReportPeriodDays } from "../domain/types";
import { collectReportMedia } from "../domain/reportPages";
import { InstagramInsightsWorkspace } from "./InstagramInsightsWorkspace";

export type InstagramPerformanceScreenProps = {
  gateway?: InstagramInsightsGateway;
};

export function InstagramPerformanceScreen({
  gateway = defaultInstagramInsightsGateway,
}: InstagramPerformanceScreenProps) {
  const { t } = useTranslation("analytics");
  const errorMessages = new Map([
    ["collection_disabled", t("instagram.collectionDisabled", "Instagram insights collection is currently disabled. Contact support to check availability.")],
    ["collection_not_eligible", t("instagram.collectionNotEligible", "This account is not enabled for Instagram insights collection yet.")],
    ["throttled", t("instagram.syncThrottled", "Too many sync requests. Please wait before trying again.")],
    ["settings_unavailable", t("instagram.insightsUnavailable", "Instagram insights are temporarily unavailable. Please try again later.")],
    ["not_found", t("instagram.accountNotFound", "Instagram account not found or no longer connected.")],
    ["unauthorized", t("instagram.signInAgain", "Please sign in again to access Instagram insights.")],
    ["forbidden", t("instagram.insightsForbidden", "You do not have permission to perform this action.")],
    ["enqueue_indeterminate", t("instagram.syncUnconfirmed", "We could not confirm whether syncing started. Wait and check the report before trying again.")],
  ]);
  const errorMessage = (error: Error, fallback: string) => errorMessages.get(error.message) ?? fallback;
  const { data: accounts = [], isLoading: isAccountsLoading, error: accountsError, refetch: refetchAccounts } = useSocialAccounts();

  const igAccounts = useMemo(
    () => accounts.filter((a) => a.platform === "instagram" && a.is_active !== false),
    [accounts],
  );

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState<OwnerReportPeriodDays>(30);

  // Auto-select first active Instagram account if none selected
  const activeAccountId = igAccounts.find((account) => account.id === selectedAccountId)?.id ?? igAccounts[0]?.id ?? null;

  const {
    data: reportPages,
    isLoading: isReportLoading,
    error: reportError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInstagramInsightsReport({
    gateway,
    socialAccountId: activeAccountId,
    periodDays,
    enabled: Boolean(activeAccountId),
  });

  const report = reportPages?.pages[0];
  const mediaItems = useMemo(() => collectReportMedia(reportPages?.pages ?? []), [reportPages]);

  const { mutate: triggerSync, isPending: isSyncing } = useTriggerInstagramSync({
    gateway,
    onSuccess: (res) => {
      toast.success(
        t("instagram.syncQueued", "Instagram insights collection queued. Status will refresh shortly."),
      );
    },
    onError: (err) => {
      toast.error(errorMessage(err, t("instagram.syncFailed", "Failed to queue sync job")));
    },
  });

  const handleTriggerSync = () => {
    if (!activeAccountId) return;
    triggerSync({ socialAccountId: activeAccountId });
  };

  return (
    <InstagramInsightsWorkspace
      accounts={accounts}
      accountsError={accountsError ? t("instagram.accountsLoadFailed", "Failed to load connected accounts. Please try again.") : null}
      onRetryAccounts={() => { void refetchAccounts({ cancelRefetch: false }); }}
      selectedAccountId={activeAccountId}
      onSelectAccount={setSelectedAccountId}
      periodDays={periodDays}
      onSelectPeriod={setPeriodDays}
      report={report}
      mediaItems={mediaItems}
      isLoading={isAccountsLoading || isReportLoading}
      error={reportError ? new Error(errorMessage(reportError, t("errors.failedToLoad", "Failed to load report"))) : null}
      isSyncing={isSyncing}
      onTriggerSync={handleTriggerSync}
      onLoadMore={hasNextPage ? () => { void fetchNextPage({ cancelRefetch: false }); } : undefined}
      isLoadingMore={isFetchingNextPage}
    />
  );
}

export default InstagramPerformanceScreen;
