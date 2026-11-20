import { useMemo } from "react";
import { Navigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { toYouTubeAccountOptions, YouTubeManagementScreen } from "@/features/youtube-management";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";

export default function YouTubeManagementPage() {
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { data: accounts = [], isLoading } = useSocialAccounts();
  const options = useMemo(() => toYouTubeAccountOptions(accounts), [accounts]);

  if (!flagsLoading && !flags.youtubeManagement) return <Navigate to="/dashboard" replace />;
  return (
    <DashboardLayout>
      <YouTubeManagementScreen accounts={options} accountsLoading={isLoading || flagsLoading} />
    </DashboardLayout>
  );
}
