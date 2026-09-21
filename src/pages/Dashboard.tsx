import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useUserRole } from "@/hooks/useUserRole";
import { usePostsWithResults, usePostStats } from "@/hooks/usePosts";
import { StatCards, RecentPosts, ConnectedAccounts } from "@/components/dashboard";
import { TypingTagline } from "@/components/dashboard/TypingTagline";
import { TokenReauthBanner } from "@/components/dashboard/TokenReauthBanner";
import { GradientHeading } from "@/components/fx";
import {
  Send,
  Link2,
  TrendingUp,
  Calendar,
  Plus,
  ExternalLink,
} from "lucide-react";

export default function Dashboard() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();
  const { flags } = useFeatureFlags();
  const { isAdmin } = useUserRole();
  const { data: accounts = [], isLoading: accountsLoading } = useSocialAccounts();
  const { data: recentPosts = [], isLoading: postsLoading } = usePostsWithResults(3);
  const { data: stats, isLoading: statsLoading } = usePostStats();

  const statsData = [
    { id: "totalPosts", label: t("stats.totalPosts", "Total Posts"), value: stats?.total.toString() || "0", icon: Send, trend: null, variant: "sky" as const },
    { id: "connectedAccounts", label: t("stats.connectedAccounts", "Connected Accounts"), value: accounts.length.toString(), icon: Link2, trend: null, variant: "violet" as const },
    { id: "scheduled", label: t("stats.scheduled", "Scheduled"), value: stats?.scheduled.toString() || "0", icon: Calendar, trend: null, variant: "amber" as const },
    { id: "successRate", label: t("stats.successRate", "Success Rate"), value: `${stats?.successRate || 0}%`, icon: TrendingUp, trend: null, variant: "emerald" as const },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Token Reauth Banner */}
        <TokenReauthBanner />

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <GradientHeading as="h1" preset="sky-violet-pink" size="lg">
              {t("header.title", "Dashboard")}
            </GradientHeading>
            <p className="text-muted-foreground mt-1">
              {t("header.welcome", "Welcome back{{name}}! Here's your posting overview.", {
                name: profile?.full_name ? `, ${profile.full_name}` : "",
              })}
            </p>
            <TypingTagline />
          </div>
          <div className="flex gap-2">
            {isAdmin && flags.marketeroButton && (
              <a href="https://marketero.postora.cloud" target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="lg">
                  <ExternalLink className="w-4 h-4 me-2" />
                  Marketero
                </Button>
              </a>
            )}
            <Link to="/post">
              <Button variant="gradient" size="lg">
                <Plus className="w-4 h-4 me-2" />
                {t("common:createPost", "Create Post")}
              </Button>
            </Link>
          </div>
        </div>

        {/* Stats Grid */}
        <StatCards stats={statsData} isLoading={statsLoading} />

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent Posts */}
          <RecentPosts posts={recentPosts} isLoading={postsLoading} />

          {/* Connected Accounts */}
          <ConnectedAccounts accounts={accounts} isLoading={accountsLoading} />
        </div>
      </div>
    </DashboardLayout>
  );
}
