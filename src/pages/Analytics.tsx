import { useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { usePostsWithResults } from "@/hooks/usePosts";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { format, subDays, startOfDay, eachDayOfInterval } from "date-fns";
import {
  AnalyticsHeader,
  AnalyticsStatCards,
  PostsOverTimeChart,
  PlatformPieChart,
  SuccessRateChart,
  PlatformPerformanceChart,
  PlatformSuccessChart,
  StatusDistributionChart,
  PostingActivityChart,
  ConnectedAccountsSummary,
} from "@/components/analytics";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function Analytics() {
  const [timeRange, setTimeRange] = useState("7");
  const { data: posts = [], error: postsError } = usePostsWithResults();
  const { data: accounts = [], error: accountsError } = useSocialAccounts();

  // Calculate date range
  const endDate = new Date();
  const startDate = subDays(endDate, parseInt(timeRange));

  // Filter posts by date range
  const filteredPosts = posts.filter((post) => {
    const postDate = new Date(post.created_at || "");
    return postDate >= startDate && postDate <= endDate;
  });

  // Calculate stats
  const totalPosts = filteredPosts.length;
  const publishedPosts = filteredPosts.filter((p) => p.status === "completed").length;
  const scheduledPosts = filteredPosts.filter((p) => (p.status === "pending" || p.status === "scheduled") && p.scheduled_at).length;
  const failedPosts = filteredPosts.filter((p) => p.status === "failed").length;

  // Calculate success rate
  const processedPosts = filteredPosts.filter((p) => p.status === "completed" || p.status === "failed");
  const successRate = processedPosts.length > 0
    ? Math.round((publishedPosts / processedPosts.length) * 100)
    : 0;

  // Posts by platform
  const platformStats = filteredPosts.reduce((acc, post) => {
    post.platforms.forEach((platform) => {
      acc[platform] = (acc[platform] || 0) + 1;
    });
    return acc;
  }, {} as Record<string, number>);

  const platformData = Object.entries(platformStats).map(([platform, count]) => ({
    name: getPlatformName(platform as Platform),
    platform,
    value: count,
  }));

  // Posts over time with success rate
  const dateInterval = eachDayOfInterval({ start: startDate, end: endDate });
  const postsOverTime = dateInterval.map((date) => {
    const dayStart = startOfDay(date);
    const dayPosts = filteredPosts.filter((post) => {
      const postDate = new Date(post.created_at || "");
      return startOfDay(postDate).getTime() === dayStart.getTime();
    });
    const published = dayPosts.filter((p) => p.status === "completed").length;
    const failed = dayPosts.filter((p) => p.status === "failed").length;
    const dayTotal = published + failed;
    return {
      date: format(date, "MMM dd"),
      posts: dayPosts.length,
      published,
      failed,
      successRate: dayTotal > 0 ? Math.round((published / dayTotal) * 100) : null,
    };
  });

  // Platform performance over time
  const platformPerformanceOverTime = dateInterval.map((date) => {
    const dayStart = startOfDay(date);
    const dayPosts = filteredPosts.filter((post) => {
      const postDate = new Date(post.created_at || "");
      return startOfDay(postDate).getTime() === dayStart.getTime();
    });

    const platformCounts: Record<string, number> = {};
    dayPosts.forEach((post) => {
      post.platforms.forEach((platform) => {
        platformCounts[platform] = (platformCounts[platform] || 0) + 1;
      });
    });

    return {
      date: format(date, "MMM dd"),
      ...platformCounts,
    };
  });

  // Get unique platforms for the chart
  const uniquePlatforms = [...new Set(filteredPosts.flatMap((p) => p.platforms))];

  // Success rate by platform
  const platformSuccessRates = uniquePlatforms.map((platform) => {
    const platformPosts = filteredPosts.filter((p) => p.platforms.includes(platform as Platform));
    let successCount = 0;
    let totalAttempts = 0;

    platformPosts.forEach((post) => {
      const result = post.platformResults?.find((r) => r.platform === platform);
      if (result) {
        totalAttempts++;
        if (result.status === "success") successCount++;
      }
    });

    return {
      platform,
      name: getPlatformName(platform as Platform),
      successRate: totalAttempts > 0 ? Math.round((successCount / totalAttempts) * 100) : 0,
      total: totalAttempts,
      successful: successCount,
    };
  });

  // Status distribution
  const statusData = [
    { name: "Published", value: publishedPosts, color: "hsl(142, 76%, 36%)" },
    { name: "Scheduled", value: scheduledPosts, color: "hsl(199, 89%, 48%)" },
    { name: "Failed", value: failedPosts, color: "hsl(0, 72%, 51%)" },
    {
      name: "Pending",
      value: totalPosts - publishedPosts - scheduledPosts - failedPosts,
      color: "hsl(215, 20%, 55%)",
    },
  ].filter((s) => s.value > 0);

  // Best posting times (hour of day)
  const hourStats = filteredPosts.reduce((acc, post) => {
    if (post.posted_at || post.scheduled_at) {
      const hour = new Date(post.posted_at || post.scheduled_at || "").getHours();
      acc[hour] = (acc[hour] || 0) + 1;
    }
    return acc;
  }, {} as Record<number, number>);

  const hourData = Array.from({ length: 24 }, (_, hour) => ({
    hour: `${hour.toString().padStart(2, "0")}:00`,
    posts: hourStats[hour] || 0,
  }));

  const getPostCountForPlatform = (platform: string) => {
    return filteredPosts.filter((p) => p.platforms.includes(platform as Platform)).length;
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <AnalyticsHeader timeRange={timeRange} onTimeRangeChange={setTimeRange} />

        {(postsError || accountsError) && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load analytics data.{" "}
              {postsError instanceof Error ? postsError.message : ""}
              {accountsError instanceof Error ? accountsError.message : ""}
              {" "}
              Try refreshing the page or re-logging in.
            </AlertDescription>
          </Alert>
        )}

        <AnalyticsStatCards
          totalPosts={totalPosts}
          publishedPosts={publishedPosts}
          scheduledPosts={scheduledPosts}
          failedPosts={failedPosts}
        />

        {/* Charts Row */}
        <div className="grid lg:grid-cols-2 gap-6">
          <PostsOverTimeChart data={postsOverTime} />
          <PlatformPieChart data={platformData} />
        </div>

        {/* Success Rate Over Time & Platform Performance */}
        <div className="grid lg:grid-cols-2 gap-6">
          <SuccessRateChart data={postsOverTime} overallSuccessRate={successRate} />
          <PlatformPerformanceChart data={platformPerformanceOverTime} platforms={uniquePlatforms} />
        </div>

        {/* Platform Success Rates */}
        <PlatformSuccessChart data={platformSuccessRates} />

        {/* Status & Hour Distribution */}
        <div className="grid lg:grid-cols-2 gap-6">
          <StatusDistributionChart data={statusData} />
          <PostingActivityChart data={hourData} />
        </div>

        {/* Connected Accounts Summary */}
        <ConnectedAccountsSummary
          accounts={accounts}
          getPostCountForPlatform={getPostCountForPlatform}
        />
      </div>
    </DashboardLayout>
  );
}
