import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Loader2, Users, CreditCard, DollarSign, TrendingUp, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { toast } from "sonner";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "@/lib/subscriptionStatus";

export default function AdminDashboard() {
  const queryClient = useQueryClient();

  // Refresh tokens mutation
  const refreshTokensMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("refresh-tokens", {
        body: { manual: true },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Tokens refreshed successfully`, {
        description: `Processed ${data?.processed || 0} accounts`,
      });
      queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
    },
    onError: (error) => {
      toast.error("Failed to refresh tokens", {
        description: error.message,
      });
    },
  });

  // Fetch stats
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      // F5 (CodeRabbit round 1): "active" alone undercounted paying
      // customers - a dunning (past_due) subscriber is still a paying
      // customer during Stripe's retry window and must be counted here too.
      const [usersResult, subscriptionsResult, messagesResult] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase
          .from("user_subscriptions")
          .select("id", { count: "exact", head: true })
          .in("status", ENTITLED_SUBSCRIPTION_STATUSES),
        supabase.from("support_messages").select("id", { count: "exact", head: true }).eq("status", "open"),
      ]);

      return {
        totalUsers: usersResult.count || 0,
        activeSubscribers: subscriptionsResult.count || 0,
        openMessages: messagesResult.count || 0,
        revenueThisMonth: 0, // Placeholder - integrate with Stripe
      };
    },
  });

  // Fetch recent users
  const { data: recentUsers = [], isLoading: usersLoading } = useQuery({
    queryKey: ["admin-recent-users"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(5);

      if (error) throw error;
      return data || [];
    },
  });

  const statCards = [
    {
      title: "Total Users",
      value: stats?.totalUsers || 0,
      icon: Users,
      description: "Registered accounts",
      trend: "+12%",
    },
    {
      title: "Active Subscribers",
      value: stats?.activeSubscribers || 0,
      icon: CreditCard,
      description: "Paid plans",
      trend: "+5%",
    },
    {
      title: "Revenue (MTD)",
      value: `$${(stats?.revenueThisMonth || 0).toFixed(2)}`,
      icon: DollarSign,
      description: "This month",
      trend: "+18%",
    },
    {
      title: "Open Tickets",
      value: stats?.openMessages || 0,
      icon: TrendingUp,
      description: "Needs attention",
      trend: null,
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold">Dashboard Overview</h2>
            <p className="text-muted-foreground">Welcome to the admin dashboard</p>
          </div>
          <Button
            onClick={() => refreshTokensMutation.mutate()}
            disabled={refreshTokensMutation.isPending}
            variant="outline"
            className="gap-2 self-start sm:self-auto"
          >
            <RefreshCw className={`w-4 h-4 ${refreshTokensMutation.isPending ? "animate-spin" : ""}`} />
            {refreshTokensMutation.isPending ? "Refreshing..." : "Refresh All Tokens"}
          </Button>
        </div>

        {/* Stats Grid */}
        {statsLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {statCards.map((stat) => (
              <Card key={stat.title}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {stat.title}
                  </CardTitle>
                  <stat.icon className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stat.value}</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                    <p className="text-xs text-muted-foreground">{stat.description}</p>
                    {stat.trend && (
                      <Badge variant="secondary" className="text-xs bg-green-500/10 text-green-600 border-green-500/30">
                        {stat.trend}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Recent Signups */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Signups</CardTitle>
            <CardDescription>Latest users who joined the platform</CardDescription>
          </CardHeader>
          <CardContent>
            {usersLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : recentUsers.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No users yet</p>
            ) : (
              <div className="space-y-4">
                {recentUsers.map((user) => (
                  <div key={user.id} className="flex items-center gap-3 sm:gap-4">
                    <Avatar>
                      <AvatarImage src={user.avatar_url || undefined} />
                      <AvatarFallback>
                        {user.full_name?.charAt(0) || user.email?.charAt(0) || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">
                        {user.full_name || "No name"}
                      </p>
                      <p className="text-sm text-muted-foreground truncate">
                        {user.email}
                      </p>
                    </div>
                    <div className="text-sm text-muted-foreground shrink-0">
                      {format(new Date(user.created_at), "MMM d, yyyy")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
