import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import type { InstagramInsightsGateway } from "../application/ports";
import { useInstagramInsightsReport } from "../application/useInstagramInsightsReport";
import { useTriggerInstagramSync } from "../application/useTriggerInstagramSync";
import { defaultInstagramInsightsGateway } from "../infrastructure/supabaseInstagramInsightsGateway";
import type { OwnerReportPeriodDays } from "../domain/types";
import { InstagramInsightsWorkspace } from "./InstagramInsightsWorkspace";

export type InstagramPerformanceScreenProps = {
  gateway?: InstagramInsightsGateway;
};

export function InstagramPerformanceScreen({
  gateway = defaultInstagramInsightsGateway,
}: InstagramPerformanceScreenProps) {
  const { t } = useTranslation("analytics");
  const { data: accounts = [], isLoading: isAccountsLoading } = useSocialAccounts();

  const igAccounts = useMemo(
    () => accounts.filter((a) => a.platform === "instagram" && a.is_active !== false),
    [accounts],
  );

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState<OwnerReportPeriodDays>(30);

  // Auto-select first active Instagram account if none selected
  const activeAccountId = selectedAccountId || igAccounts[0]?.id || null;

  const {
    data: report,
    isLoading: isReportLoading,
    error: reportError,
  } = useInstagramInsightsReport({
    gateway,
    socialAccountId: activeAccountId,
    periodDays,
    enabled: Boolean(activeAccountId),
  });

  const { mutate: triggerSync, isPending: isSyncing } = useTriggerInstagramSync({
    gateway,
    onSuccess: (res) => {
      toast.success(
        t("instagram.syncQueued", "Instagram insights collection queued. Status will refresh shortly."),
      );
    },
    onError: (err) => {
      toast.error(err.message || t("instagram.syncFailed", "Failed to queue sync job"));
    },
  });

  const handleTriggerSync = () => {
    if (!activeAccountId) return;
    triggerSync({ socialAccountId: activeAccountId });
  };

  return (
    <InstagramInsightsWorkspace
      accounts={accounts}
      selectedAccountId={activeAccountId}
      onSelectAccount={setSelectedAccountId}
      periodDays={periodDays}
      onSelectPeriod={setPeriodDays}
      report={report}
      isLoading={isAccountsLoading || isReportLoading}
      error={reportError}
      isSyncing={isSyncing}
      onTriggerSync={handleTriggerSync}
    />
  );
}

export default InstagramPerformanceScreen;
