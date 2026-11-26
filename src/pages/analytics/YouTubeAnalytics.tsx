import { useMemo } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { YouTubeAnalyticsScreen, type YouTubeAnalyticsAccount } from "@/features/youtube-analytics";
import { useAuth } from "@/hooks/useAuth";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";

export default function YouTubeAnalytics() {
  const { t } = useTranslation("analytics");
  const { user } = useAuth();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { data: accounts = [], isLoading, error, refetch } = useSocialAccounts();
  const [searchParams] = useSearchParams();
  const options = useMemo<YouTubeAnalyticsAccount[]>(() => accounts
    .filter((account) => account.platform === "youtube")
    .map((account) => ({
      id: account.id,
      title: account.platform_username ?? "YouTube",
      avatarUrl: account.avatar_url,
      provider: account.auth_provider === "composio" ? "composio" : "native",
    })), [accounts]);

  if (flagsLoading) {
    return <DashboardLayout><p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p></DashboardLayout>;
  }
  if (!flags.analyticsYoutube) return <Navigate to="/dashboard" replace />;

  return (
    <DashboardLayout>
      <YouTubeAnalyticsScreen
        userId={user?.id ?? ""}
        accounts={options}
        accountsLoading={isLoading}
        accountsError={error}
        onRetryAccounts={() => void refetch()}
        initialAccountId={searchParams.get("account")}
        initialVideoId={searchParams.get("video")}
      />
    </DashboardLayout>
  );
}
