import { useMemo } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { toYouTubeAccountOptions, YouTubeManagementScreen } from "@/features/youtube-management";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";

export default function YouTubeManagementPage() {
  const { t } = useTranslation("accounts");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { data: accounts = [], isLoading, error, refetch } = useSocialAccounts();
  const options = useMemo(() => toYouTubeAccountOptions(accounts), [accounts]);

  // Until the flags resolve we mount nothing: the screen's queries would
  // start edge calls that a flag-off redirect then renders wasted.
  if (flagsLoading) {
    return (
      <DashboardLayout>
        <p role="status" className="text-sm text-muted-foreground">{t("youtubeManagement.loading", "Loading…")}</p>
      </DashboardLayout>
    );
  }
  if (!flags.youtubeManagement) return <Navigate to="/dashboard" replace />;
  return (
    <DashboardLayout>
      <YouTubeManagementScreen
        accounts={options}
        accountsLoading={isLoading || flagsLoading}
        accountsError={error}
        onRetryAccounts={() => void refetch()}
      />
    </DashboardLayout>
  );
}
