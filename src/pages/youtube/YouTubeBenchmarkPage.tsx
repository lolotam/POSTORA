import { useMemo } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { toYouTubeBenchmarkAccountOptions, YouTubeBenchmarkScreen } from "@/features/youtube-benchmark";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";

export default function YouTubeBenchmarkPage() {
  const { t } = useTranslation("accounts");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { data: accounts = [], isLoading, error, refetch } = useSocialAccounts();
  const options = useMemo(() => toYouTubeBenchmarkAccountOptions(accounts), [accounts]);

  // Until the flags resolve we mount nothing: the screen's queries would
  // start edge calls that a flag-off redirect then renders wasted.
  if (flagsLoading) {
    return (
      <DashboardLayout>
        <p role="status" className="text-sm text-muted-foreground">
          {t("youtubeBenchmark.loading", "Loading…")}
        </p>
      </DashboardLayout>
    );
  }
  if (!flags.youtubeBenchmark) return <Navigate to="/dashboard" replace />;
  return (
    <DashboardLayout>
      <YouTubeBenchmarkScreen
        accounts={options}
        accountsLoading={isLoading || flagsLoading}
        accountsError={error}
        onRetryAccounts={() => void refetch()}
      />
    </DashboardLayout>
  );
}
