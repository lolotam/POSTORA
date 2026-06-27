import { useQuery } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Users, Activity, TrendingUp, Database, HardDrive, Zap, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format, subDays, subHours, startOfDay, endOfDay, eachDayOfInterval } from "date-fns";
import { useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from "recharts";

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export default function AdminAnalytics() {
  const [timeRange, setTimeRange] = useState("7d");

  const getDateRange = () => {
    const now = new Date();
    switch (timeRange) {
      case "24h":
        return { start: subHours(now, 24), end: now };
      case "7d":
        return { start: subDays(now, 7), end: now };
      case "30d":
        return { start: subDays(now, 30), end: now };
      case "90d":
        return { start: subDays(now, 90), end: now };
      default:
        return { start: subDays(now, 7), end: now };
    }
  };

  const { start, end } = getDateRange();

  // User growth data
  const { data: userStats, isLoading: userStatsLoading, refetch: refetchUsers } = useQuery({
    queryKey: ["admin-user-stats", timeRange],
    queryFn: async () => {
      // Total users
      const { count: totalUsers } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true });

      // New users in period
      const { count: newUsers } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .gte("created_at", start.toISOString());

      // Active users (posted in period)
      const { data: activePosts } = await supabase
        .from("posts")
        .select("user_id")
        .gte("created_at", start.toISOString());
      
      const activeUsers = new Set(activePosts?.map(p => p.user_id) || []).size;

      // Users with subscriptions
      const { count: subscribers } = await supabase
        .from("user_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("status", "active");

      return {
        totalUsers: totalUsers || 0,
        newUsers: newUsers || 0,
        activeUsers,
        subscribers: subscribers || 0,
        conversionRate: totalUsers ? ((subscribers || 0) / totalUsers * 100).toFixed(1) : "0",
      };
    },
  });

  // Daily signup trend
  const { data: signupTrend, isLoading: signupTrendLoading } = useQuery({
    queryKey: ["admin-signup-trend", timeRange],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("created_at")
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString());

      const days = eachDayOfInterval({ start, end });
      const signupsByDay = days.map(day => {
        const dayStart = startOfDay(day);
        const dayEnd = endOfDay(day);
        const count = data?.filter(u => {
          const createdAt = new Date(u.created_at);
          return createdAt >= dayStart && createdAt <= dayEnd;
        }).length || 0;

        return {
          date: format(day, "MMM d"),
          signups: count,
        };
      });

      return signupsByDay;
    },
  });

  // Resource usage stats
  const { data: resourceStats, isLoading: resourceStatsLoading, refetch: refetchResources } = useQuery({
    queryKey: ["admin-resource-stats"],
    queryFn: async () => {
      const [postsResult, accountsResult, mediaResult, logsResult] = await Promise.all([
        supabase.from("posts").select("id", { count: "exact", head: true }),
        supabase.from("social_accounts").select("id", { count: "exact", head: true }),
        supabase.from("media_files").select("id, file_size", { count: "exact" }),
        supabase.from("system_logs").select("id", { count: "exact", head: true }),
      ]);

      const totalStorageBytes = mediaResult.data?.reduce((sum, f) => sum + (f.file_size || 0), 0) || 0;
      const totalStorageMB = (totalStorageBytes / (1024 * 1024)).toFixed(2);

      return {
        totalPosts: postsResult.count || 0,
        totalAccounts: accountsResult.count || 0,
        totalMedia: mediaResult.count || 0,
        totalLogs: logsResult.count || 0,
        storageMB: totalStorageMB,
      };
    },
  });

  // Platform distribution
  const { data: platformStats, isLoading: platformStatsLoading } = useQuery({
    queryKey: ["admin-platform-stats"],
    queryFn: async () => {
      const { data } = await supabase
        .from("social_accounts")
        .select("platform");

      const counts: Record<string, number> = {};
      data?.forEach(acc => {
        counts[acc.platform] = (counts[acc.platform] || 0) + 1;
      });

      return Object.entries(counts).map(([platform, count]) => ({
        platform: platform.charAt(0).toUpperCase() + platform.slice(1),
        count,
      }));
    },
  });

  // API usage stats
  const { data: apiStats, isLoading: apiStatsLoading } = useQuery({
    queryKey: ["admin-api-stats", timeRange],
    queryFn: async () => {
      const { data, count } = await supabase
        .from("api_logs")
        .select("endpoint, status_code", { count: "exact" })
        .gte("created_at", start.toISOString());

      const successCount = data?.filter(l => l.status_code && l.status_code < 400).length || 0;
      const errorCount = data?.filter(l => l.status_code && l.status_code >= 400).length || 0;

      const endpointCounts: Record<string, number> = {};
      data?.forEach(log => {
        endpointCounts[log.endpoint] = (endpointCounts[log.endpoint] || 0) + 1;
      });

      const topEndpoints = Object.entries(endpointCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([endpoint, count]) => ({ endpoint, count }));

      return {
        totalRequests: count || 0,
        successCount,
        errorCount,
        successRate: count ? ((successCount / count) * 100).toFixed(1) : "100",
        topEndpoints,
      };
    },
  });

  const isLoading = userStatsLoading || signupTrendLoading || resourceStatsLoading || platformStatsLoading || apiStatsLoading;

  const handleRefresh = () => {
    refetchUsers();
    refetchResources();
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Platform Analytics</h2>
            <p className="text-muted-foreground">Monitor user growth, engagement, and resource usage</p>
          </div>
          <div className="flex items-center gap-3">
            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* User Stats Cards */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Total Users</CardTitle>
                  <Users className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{userStats?.totalUsers.toLocaleString()}</div>
                  <p className="text-xs text-muted-foreground mt-1">All registered users</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">New Users</CardTitle>
                  <TrendingUp className="w-4 h-4 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">+{userStats?.newUsers}</div>
                  <p className="text-xs text-muted-foreground mt-1">In selected period</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Active Users</CardTitle>
                  <Activity className="w-4 h-4 text-blue-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{userStats?.activeUsers}</div>
                  <p className="text-xs text-muted-foreground mt-1">Posted in period</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Subscribers</CardTitle>
                  <Zap className="w-4 h-4 text-yellow-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{userStats?.subscribers}</div>
                  <p className="text-xs text-muted-foreground mt-1">Active paid plans</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Conversion</CardTitle>
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{userStats?.conversionRate}%</div>
                  <p className="text-xs text-muted-foreground mt-1">Users → Subscribers</p>
                </CardContent>
              </Card>
            </div>

            {/* Charts Row */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Signup Trend */}
              <Card>
                <CardHeader>
                  <CardTitle>User Signups</CardTitle>
                  <CardDescription>Daily new user registrations</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={signupTrend || []}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="date" className="text-xs" />
                        <YAxis className="text-xs" />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--popover))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "8px",
                          }}
                        />
                        <Line
                          type="monotone"
                          dataKey="signups"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          dot={{ fill: "hsl(var(--primary))" }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Platform Distribution */}
              <Card>
                <CardHeader>
                  <CardTitle>Platform Distribution</CardTitle>
                  <CardDescription>Connected accounts by platform</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={platformStats || []}
                          dataKey="count"
                          nameKey="platform"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          label={(props: any) => `${props.platform}: ${props.count}`}
                        >
                          {(platformStats || []).map((_, index) => (
                            <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Resource Usage */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Total Posts</CardTitle>
                  <Database className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{resourceStats?.totalPosts.toLocaleString()}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Social Accounts</CardTitle>
                  <Users className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{resourceStats?.totalAccounts}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Media Files</CardTitle>
                  <HardDrive className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{resourceStats?.totalMedia}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Storage Used</CardTitle>
                  <HardDrive className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{resourceStats?.storageMB} MB</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">System Logs</CardTitle>
                  <Database className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{resourceStats?.totalLogs.toLocaleString()}</div>
                </CardContent>
              </Card>
            </div>

            {/* API Stats */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>API Usage</CardTitle>
                  <CardDescription>Request statistics for selected period</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Total Requests</span>
                      <span className="font-bold">{apiStats?.totalRequests.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Successful</span>
                      <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/30">
                        {apiStats?.successCount.toLocaleString()}
                      </Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Errors</span>
                      <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/30">
                        {apiStats?.errorCount.toLocaleString()}
                      </Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Success Rate</span>
                      <span className="font-bold text-green-600">{apiStats?.successRate}%</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Top Endpoints</CardTitle>
                  <CardDescription>Most used API endpoints</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[200px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={apiStats?.topEndpoints || []} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis type="number" className="text-xs" />
                        <YAxis dataKey="endpoint" type="category" className="text-xs" width={120} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--popover))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "8px",
                          }}
                        />
                        <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
