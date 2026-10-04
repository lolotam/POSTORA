import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  RefreshCw, Search, AlertCircle, CheckCircle, Clock, 
  AlertTriangle, Shield, Zap, TrendingUp, TrendingDown,
  BellOff, Bell, RotateCcw, PlayCircle, Timer, Gauge, History,
  Download, Trash2
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { supabase } from "@/integrations/supabase/client";
import { format, formatDistanceToNow, differenceInHours, differenceInDays, subHours, startOfHour } from "date-fns";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { 
  PLATFORM_TOKEN_INFO, 
  SHORT_LIVED_TOKEN_PLATFORMS,
  MEDIUM_LIVED_TOKEN_PLATFORMS,
  LONG_LIVED_TOKEN_PLATFORMS 
} from "@/lib/tokenExpiryConstants";

type TokenStatus = "healthy" | "expiring" | "expired" | "unknown" | "needs_reauth";

interface SocialAccountWithHealth {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
  token_expires_at: string | null;
  updated_at: string | null;
  is_active: boolean;
  user_id: string;
  user_email?: string;
  status: TokenStatus;
  hoursUntilExpiry: number | null;
  lastRefreshed: string | null;
  // New fields for token health tracking
  needs_reauth: boolean;
  failure_count: number;
  last_refresh_error: string | null;
  last_alert_sent_at: string | null;
  alerts_snoozed: boolean;
  last_refresh_attempt_at: string | null;
}

interface RefreshHistoryEntry {
  id: string;
  account_id: string;
  platform: string;
  platform_username: string | null;
  status: string;
  error_message: string | null;
  trigger_type: string;
  cron_category: string | null;
  duration_ms: number | null;
  created_at: string;
}

function getTokenStatus(expiresAt: string | null, platform: string, needsReauth?: boolean): { status: TokenStatus; hoursUntilExpiry: number | null } {
  // Check if marked as needs_reauth first
  if (needsReauth) return { status: "needs_reauth", hoursUntilExpiry: null };
  
  if (!expiresAt) return { status: "unknown", hoursUntilExpiry: null };
  
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const hoursUntilExpiry = differenceInHours(expiryDate, now);
  
  if (hoursUntilExpiry < 0) return { status: "expired", hoursUntilExpiry };
  
  // Get platform-specific threshold
  const platformInfo = PLATFORM_TOKEN_INFO[platform.toLowerCase()];
  const thresholdHours = platformInfo ? platformInfo.refreshWindowSeconds / 3600 : 168; // Default 7 days
  
  if (hoursUntilExpiry <= thresholdHours) return { status: "expiring", hoursUntilExpiry };
  
  return { status: "healthy", hoursUntilExpiry };
}

function getStatusBadge(status: TokenStatus) {
  switch (status) {
    case "healthy":
      return <Badge className="bg-green-500/10 text-green-500 border-green-500/30"><CheckCircle className="w-3 h-3 me-1" />Healthy</Badge>;
    case "expiring":
      return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30"><AlertTriangle className="w-3 h-3 me-1" />Expiring Soon</Badge>;
    case "expired":
      return <Badge className="bg-red-500/10 text-red-500 border-red-500/30"><AlertCircle className="w-3 h-3 me-1" />Expired</Badge>;
    case "needs_reauth":
      return <Badge className="bg-red-600/10 text-red-600 border-red-600/30"><RotateCcw className="w-3 h-3 me-1" />Needs Reconnect</Badge>;
    default:
      return <Badge variant="outline"><Clock className="w-3 h-3 me-1" />Unknown</Badge>;
  }
}

export default function AdminTokenHealth() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [refreshingCategory, setRefreshingCategory] = useState<'short' | 'medium' | 'long' | null>(null);
  
  // History filters
  const [historyPlatformFilter, setHistoryPlatformFilter] = useState("all");
  const [historyStatusFilter, setHistoryStatusFilter] = useState("all");
  const [historyTriggerFilter, setHistoryTriggerFilter] = useState("all");

  // Fetch all social accounts with token info including new health fields
  const { data: accounts = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-token-health"],
    queryFn: async () => {
      // Get all social accounts
      const { data: socialAccounts, error } = await supabase
        .from("social_accounts")
        .select("id, platform, platform_username, avatar_url, token_expires_at, updated_at, is_active, user_id, needs_reauth, failure_count, last_refresh_error, last_alert_sent_at, alerts_snoozed, last_refresh_attempt_at")
        .eq("is_active", true)
        .order("token_expires_at", { ascending: true, nullsFirst: false });

      if (error) throw error;

      // Get user emails for each account
      const userIds = [...new Set(socialAccounts?.map(a => a.user_id) || [])];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email")
        .in("id", userIds);

      const userEmailMap = new Map(profiles?.map(p => [p.id, p.email]) || []);

      // Process accounts with health status
      return (socialAccounts || []).map(account => {
        const { status, hoursUntilExpiry } = getTokenStatus(account.token_expires_at, account.platform, account.needs_reauth);
        return {
          ...account,
          user_email: userEmailMap.get(account.user_id),
          status,
          hoursUntilExpiry,
          lastRefreshed: account.updated_at,
          needs_reauth: account.needs_reauth || false,
          failure_count: account.failure_count || 0,
          last_refresh_error: account.last_refresh_error,
          last_alert_sent_at: account.last_alert_sent_at,
          alerts_snoozed: account.alerts_snoozed || false,
          last_refresh_attempt_at: account.last_refresh_attempt_at || null,
        } as SocialAccountWithHealth;
      });
    },
    refetchInterval: 60000, // Refresh every minute
  });

  // Fetch refresh history
  const { data: refreshHistory = [], isLoading: historyLoading, refetch: refetchHistory } = useQuery({
    queryKey: ["admin-refresh-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("token_refresh_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      return (data || []) as RefreshHistoryEntry[];
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Force refresh tokens mutation
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("refresh-tokens", {
        body: { manual: true },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Token refresh completed", {
        description: `Refreshed: ${data?.refreshed || 0}, Failed: ${data?.failed || 0}`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-token-health"] });
    },
    onError: (error) => {
      toast.error("Refresh failed", { description: error.message });
    },
  });

  // Toggle alerts snoozed for an account
  const toggleSnoozeMutation = useMutation({
    mutationFn: async ({ accountId, snoozed }: { accountId: string; snoozed: boolean }) => {
      const { error } = await supabase
        .from("social_accounts")
        .update({ alerts_snoozed: snoozed })
        .eq("id", accountId);
      if (error) throw error;
    },
    onSuccess: (_, { snoozed }) => {
      toast.success(snoozed ? "Alerts snoozed for this account" : "Alerts enabled for this account");
      queryClient.invalidateQueries({ queryKey: ["admin-token-health"] });
    },
    onError: (error) => {
      toast.error("Failed to update", { description: error.message });
    },
  });

  // Reset account - clear needs_reauth flag
  const resetAccountMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase
        .from("social_accounts")
        .update({ 
          needs_reauth: false, 
          failure_count: 0, 
          last_refresh_error: null 
        })
        .eq("id", accountId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Account reset - will retry on next refresh");
      queryClient.invalidateQueries({ queryKey: ["admin-token-health"] });
    },
    onError: (error) => {
      toast.error("Failed to reset", { description: error.message });
    },
  });

  // Force refresh a single account (bypasses cooldown)
  const forceRefreshAccountMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const { data, error } = await supabase.functions.invoke("refresh-tokens", {
        body: { accountId, force: true },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const status = data?.status || 'unknown';
      if (status === 'refreshed') {
        toast.success("Token refreshed successfully", {
          description: data?.avatarRefreshed ? "Avatar also updated" : undefined,
        });
      } else if (status === 'already_refreshed') {
        toast.info("Token was already refreshed by another process");
      } else if (status === 'failed' || status === 'error' || status === 'needs_reauth') {
        toast.error("Refresh failed", { description: data?.error || "Unknown error" });
      } else {
        toast.info(`Refresh result: ${status}`);
      }
      queryClient.invalidateQueries({ queryKey: ["admin-token-health"] });
    },
    onError: (error) => {
      toast.error("Force refresh failed", { description: error.message });
    },
  });

  // Bulk force refresh mutation
  const bulkForceRefreshMutation = useMutation({
    mutationFn: async (accountIds: string[]) => {
      const { data, error } = await supabase.functions.invoke("refresh-tokens", {
        body: { accountIds, force: true },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const refreshed = data?.refreshed || 0;
      const failed = data?.failed || 0;
      const total = data?.total || 0;
      toast.success("Bulk refresh complete", {
        description: `Refreshed: ${refreshed}, Failed: ${failed}, Total: ${total}`,
      });
      setSelectedAccounts(new Set());
      queryClient.invalidateQueries({ queryKey: ["admin-token-health"] });
    },
    onError: (error) => {
      toast.error("Bulk refresh failed", { description: error.message });
    },
  });

  // Trigger cron category mutation
  const triggerCronCategoryMutation = useMutation({
    mutationFn: async (category: 'short' | 'medium' | 'long') => {
      setRefreshingCategory(category);
      const platformsMap = {
        short: SHORT_LIVED_TOKEN_PLATFORMS,
        medium: MEDIUM_LIVED_TOKEN_PLATFORMS,
        long: LONG_LIVED_TOKEN_PLATFORMS,
      };
      const { data, error } = await supabase.functions.invoke("refresh-tokens", {
        body: { platforms: platformsMap[category], manual: true },
      });
      if (error) throw error;
      return { ...data, category };
    },
    onSuccess: (data) => {
      const categoryLabels = { short: 'Short-lived', medium: 'Medium-lived', long: 'Long-lived' };
      toast.success(`${categoryLabels[data.category as keyof typeof categoryLabels]} refresh complete`, {
        description: `Refreshed: ${data?.refreshed || 0}, Failed: ${data?.failed || 0}`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-token-health"] });
      setRefreshingCategory(null);
    },
    onError: (error) => {
      toast.error("Category refresh failed", { description: error.message });
      setRefreshingCategory(null);
    },
  });

  // Cleanup old history entries mutation
  const cleanupHistoryMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("cleanup_old_token_refresh_history");
      if (error) throw error;
      return data as number;
    },
    onSuccess: (deletedCount) => {
      toast.success("History cleanup complete", {
        description: `Deleted ${deletedCount} entries older than 7 days`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-refresh-history"] });
    },
    onError: (error) => {
      toast.error("Cleanup failed", { description: error.message });
    },
  });

  // Export history to CSV
  const exportHistoryToCSV = () => {
    const filteredData = refreshHistory.filter(entry => {
      if (historyPlatformFilter !== 'all' && entry.platform !== historyPlatformFilter) return false;
      if (historyStatusFilter !== 'all' && entry.status !== historyStatusFilter) return false;
      if (historyTriggerFilter !== 'all' && entry.trigger_type !== historyTriggerFilter) return false;
      return true;
    });

    if (filteredData.length === 0) {
      toast.error("No data to export");
      return;
    }

    // CSV headers
    const headers = [
      "Timestamp",
      "Platform",
      "Account Username",
      "Account ID",
      "Status",
      "Trigger Type",
      "Cron Category",
      "Duration (ms)",
      "Error Message"
    ];

    // CSV rows
    const rows = filteredData.map(entry => [
      entry.created_at,
      entry.platform,
      entry.platform_username || "",
      entry.account_id,
      entry.status,
      entry.trigger_type,
      entry.cron_category || "",
      entry.duration_ms?.toString() || "",
      (entry.error_message || "").replace(/"/g, '""') // Escape quotes
    ]);

    // Build CSV content
    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(","))
    ].join("\n");

    // Create and download file
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `token-refresh-history-${format(new Date(), "yyyy-MM-dd-HHmmss")}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast.success("Export complete", {
      description: `Exported ${filteredData.length} entries to CSV`,
    });
  };

  // Toggle account selection
  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  // Select all filtered accounts
  const selectAllFiltered = () => {
    if (selectedAccounts.size === filteredAccounts.length) {
      setSelectedAccounts(new Set());
    } else {
      setSelectedAccounts(new Set(filteredAccounts.map(a => a.id)));
    }
  };

  // Filter accounts
  const filteredAccounts = accounts.filter(account => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!account.platform_username?.toLowerCase().includes(query) &&
          !account.user_email?.toLowerCase().includes(query) &&
          !account.platform.toLowerCase().includes(query)) {
        return false;
      }
    }
    if (selectedPlatform !== "all" && account.platform !== selectedPlatform) return false;
    if (selectedStatus !== "all" && account.status !== selectedStatus) return false;
    return true;
  });

  // Stats
  const healthyCount = accounts.filter(a => a.status === "healthy").length;
  const expiringCount = accounts.filter(a => a.status === "expiring").length;
  const expiredCount = accounts.filter(a => a.status === "expired").length;
  const unknownCount = accounts.filter(a => a.status === "unknown").length;
  const needsReauthCount = accounts.filter(a => a.status === "needs_reauth").length;
  const totalCount = accounts.length;

  const healthPercentage = totalCount > 0 ? Math.round((healthyCount / totalCount) * 100) : 0;

  // Get unique platforms for filter
  const platforms = [...new Set(accounts.map(a => a.platform))].sort();

  // Helper to get platform schedule category
  const getPlatformScheduleCategory = (platform: string): { label: string; color: string; interval: string } => {
    const p = platform.toLowerCase();
    if ((SHORT_LIVED_TOKEN_PLATFORMS as readonly string[]).includes(p)) {
      return { label: 'Short', color: 'bg-orange-500/10 text-orange-500 border-orange-500/30', interval: '30min' };
    }
    if ((MEDIUM_LIVED_TOKEN_PLATFORMS as readonly string[]).includes(p)) {
      return { label: 'Medium', color: 'bg-blue-500/10 text-blue-500 border-blue-500/30', interval: '1hr' };
    }
    if ((LONG_LIVED_TOKEN_PLATFORMS as readonly string[]).includes(p)) {
      return { label: 'Long', color: 'bg-green-500/10 text-green-500 border-green-500/30', interval: '6hr' };
    }
    return { label: 'Unknown', color: 'bg-muted text-muted-foreground', interval: '?' };
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Token Health Dashboard</h2>
            <p className="text-muted-foreground">Monitor OAuth token status for all connected accounts</p>
          </div>
          <Button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
            {refreshMutation.isPending ? "Refreshing..." : "Force Refresh All"}
          </Button>
        </div>

        {/* Overview Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{totalCount}</p>
                  <p className="text-xs text-muted-foreground">Total Accounts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-green-500">{healthyCount}</p>
                  <p className="text-xs text-muted-foreground">Healthy</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-yellow-500">{expiringCount}</p>
                  <p className="text-xs text-muted-foreground">Expiring Soon</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-red-500">{expiredCount}</p>
                  <p className="text-xs text-muted-foreground">Expired</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-600/10 flex items-center justify-center">
                  <RotateCcw className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-red-600">{needsReauthCount}</p>
                  <p className="text-xs text-muted-foreground">Needs Reconnect</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{healthPercentage}%</p>
                  <p className="text-xs text-muted-foreground">Health Rate</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Health Progress Bar */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Overall Token Health</span>
              <span className="text-sm text-muted-foreground">{healthyCount} of {totalCount} healthy</span>
            </div>
            <div className="flex h-3 rounded-full overflow-hidden bg-muted">
              {healthyCount > 0 && (
                <div 
                  className="bg-green-500 transition-all" 
                  style={{ width: `${(healthyCount / totalCount) * 100}%` }} 
                />
              )}
              {expiringCount > 0 && (
                <div 
                  className="bg-yellow-500 transition-all" 
                  style={{ width: `${(expiringCount / totalCount) * 100}%` }} 
                />
              )}
              {expiredCount > 0 && (
                <div 
                  className="bg-red-500 transition-all" 
                  style={{ width: `${(expiredCount / totalCount) * 100}%` }} 
                />
              )}
              {needsReauthCount > 0 && (
                <div 
                  className="bg-red-600 transition-all" 
                  style={{ width: `${(needsReauthCount / totalCount) * 100}%` }} 
                />
              )}
              {unknownCount > 0 && (
                <div 
                  className="bg-gray-400 transition-all" 
                  style={{ width: `${(unknownCount / totalCount) * 100}%` }} 
                />
              )}
            </div>
            <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-green-500" /> Healthy</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-yellow-500" /> Expiring</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-red-500" /> Expired</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-red-600" /> Needs Reconnect</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-gray-400" /> Unknown</span>
            </div>
          </CardContent>
        </Card>

        {/* Cron Job Triggers */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Gauge className="w-5 h-5" />
                  Cron Job Categories
                </CardTitle>
                <CardDescription>Manually trigger refresh for specific token lifespan categories</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Short-lived */}
              <div className="p-4 rounded-lg border bg-orange-500/5 border-orange-500/20">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-orange-500">Short-lived</h4>
                    <p className="text-xs text-muted-foreground">Every 30 minutes</p>
                  </div>
                  <Badge className="bg-orange-500/10 text-orange-500 border-orange-500/30">
                    <Zap className="w-3 h-3 me-1" />
                    30min
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {SHORT_LIVED_TOKEN_PLATFORMS.map(p => (
                    <Badge key={p} variant="outline" className="text-xs capitalize">
                      <PlatformIcon platform={p as ExtendedPlatform} size="xs" className="me-1" />
                      {getPlatformName(p as ExtendedPlatform)}
                    </Badge>
                  ))}
                </div>
                <Button
                  onClick={() => triggerCronCategoryMutation.mutate('short')}
                  disabled={refreshingCategory !== null}
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 border-orange-500/30 hover:bg-orange-500/10"
                >
                  <PlayCircle className={`w-4 h-4 ${refreshingCategory === 'short' ? "animate-spin" : ""}`} />
                  {refreshingCategory === 'short' ? "Refreshing..." : "Run Short-lived Refresh"}
                </Button>
              </div>

              {/* Medium-lived */}
              <div className="p-4 rounded-lg border bg-blue-500/5 border-blue-500/20">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-blue-500">Medium-lived</h4>
                    <p className="text-xs text-muted-foreground">Every hour (at :15)</p>
                  </div>
                  <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/30">
                    <Clock className="w-3 h-3 me-1" />
                    1hr
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {MEDIUM_LIVED_TOKEN_PLATFORMS.map(p => (
                    <Badge key={p} variant="outline" className="text-xs capitalize">
                      <PlatformIcon platform={p as ExtendedPlatform} size="xs" className="me-1" />
                      {getPlatformName(p as ExtendedPlatform)}
                    </Badge>
                  ))}
                </div>
                <Button
                  onClick={() => triggerCronCategoryMutation.mutate('medium')}
                  disabled={refreshingCategory !== null}
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 border-blue-500/30 hover:bg-blue-500/10"
                >
                  <PlayCircle className={`w-4 h-4 ${refreshingCategory === 'medium' ? "animate-spin" : ""}`} />
                  {refreshingCategory === 'medium' ? "Refreshing..." : "Run Medium-lived Refresh"}
                </Button>
              </div>

              {/* Long-lived */}
              <div className="p-4 rounded-lg border bg-green-500/5 border-green-500/20">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-green-500">Long-lived</h4>
                    <p className="text-xs text-muted-foreground">Every 6 hours (at :30)</p>
                  </div>
                  <Badge className="bg-green-500/10 text-green-500 border-green-500/30">
                    <Timer className="w-3 h-3 me-1" />
                    6hr
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {LONG_LIVED_TOKEN_PLATFORMS.map(p => (
                    <Badge key={p} variant="outline" className="text-xs capitalize">
                      <PlatformIcon platform={p as ExtendedPlatform} size="xs" className="me-1" />
                      {getPlatformName(p as ExtendedPlatform)}
                    </Badge>
                  ))}
                </div>
                <Button
                  onClick={() => triggerCronCategoryMutation.mutate('long')}
                  disabled={refreshingCategory !== null}
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 border-green-500/30 hover:bg-green-500/10"
                >
                  <PlayCircle className={`w-4 h-4 ${refreshingCategory === 'long' ? "animate-spin" : ""}`} />
                  {refreshingCategory === 'long' ? "Refreshing..." : "Run Long-lived Refresh"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Platform Summary */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {platforms.map(platform => {
            const platformAccounts = accounts.filter(a => a.platform === platform);
            const platformHealthy = platformAccounts.filter(a => a.status === "healthy").length;
            const platformTotal = platformAccounts.length;
            const platformInfo = PLATFORM_TOKEN_INFO[platform.toLowerCase()];
            const scheduleCategory = getPlatformScheduleCategory(platform);
            
            return (
              <Card key={platform} className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <PlatformIcon platform={platform as ExtendedPlatform} size="sm" />
                  <span className="font-medium text-sm capitalize">{getPlatformName(platform as ExtendedPlatform)}</span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted-foreground">{platformHealthy}/{platformTotal}</span>
                  <Badge variant="outline" className="text-xs">
                    {platformInfo?.accessTokenExpiry || "Unknown"}
                  </Badge>
                </div>
                <Badge className={`text-xs ${scheduleCategory.color}`}>
                  <Gauge className="w-3 h-3 me-1" />
                  {scheduleCategory.label} ({scheduleCategory.interval})
                </Badge>
              </Card>
            );
          })}
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by username, email, or platform..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="ps-10"
                  />
                </div>
              </div>
              <Select value={selectedPlatform} onValueChange={setSelectedPlatform}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Platform" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Platforms</SelectItem>
                  {platforms.map(p => (
                    <SelectItem key={p} value={p}>
                      <span className="capitalize">{getPlatformName(p as ExtendedPlatform)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="healthy">Healthy</SelectItem>
                  <SelectItem value="expiring">Expiring</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                  <SelectItem value="needs_reauth">Needs Reconnect</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Accounts Table */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Connected Accounts</CardTitle>
                <CardDescription>All OAuth tokens with expiry status</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedAccounts.size > 0 && (
                  <Button
                    onClick={() => bulkForceRefreshMutation.mutate(Array.from(selectedAccounts))}
                    disabled={bulkForceRefreshMutation.isPending}
                    size="sm"
                    className="gap-2"
                  >
                    <RefreshCw className={`w-3 h-3 ${bulkForceRefreshMutation.isPending ? "animate-spin" : ""}`} />
                    Refresh {selectedAccounts.size} Selected
                  </Button>
                )}
                <Badge variant="secondary">{filteredAccounts.length} accounts</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* The rows are fixed-width columns; on phones let the viewport
                scroll sideways instead of clipping them (Radix forces overflow-x hidden). */}
            <ScrollArea className="h-[500px] max-md:[&>[data-radix-scroll-area-viewport]]:!overflow-x-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : filteredAccounts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Shield className="w-12 h-12 mb-3 opacity-50" />
                  <p>No accounts found</p>
                </div>
              ) : (
                <div className="divide-y">
                  {/* Header row with select all */}
                  <div className="p-3 bg-muted/30 flex items-center gap-4 text-xs font-medium text-muted-foreground">
                    <Checkbox
                      checked={selectedAccounts.size === filteredAccounts.length && filteredAccounts.length > 0}
                      onCheckedChange={selectAllFiltered}
                      className="ms-1"
                    />
                    <span className="w-10">Avatar</span>
                    <span className="flex-1 max-md:min-w-[10rem]">Account</span>
                    <span className="w-32 text-end">Status</span>
                    <span className="w-32 text-end">Failures</span>
                    <span className="w-28 text-end">Last Attempt</span>
                    <span className="w-28 text-end">Last Updated</span>
                    <span className="w-24 text-center">Alerts</span>
                    <span className="w-32 text-center">Actions</span>
                  </div>
                  
                  {filteredAccounts.map((account) => (
                    <div key={account.id} className={`p-4 hover:bg-muted/50 transition-colors ${selectedAccounts.has(account.id) ? 'bg-primary/5' : ''}`}>
                      <div className="flex items-center gap-4">
                        {/* Selection Checkbox */}
                        <Checkbox
                          checked={selectedAccounts.has(account.id)}
                          onCheckedChange={() => toggleAccountSelection(account.id)}
                        />
                        
                        <Avatar className="w-10 h-10">
                          <AvatarImage src={account.avatar_url || undefined} />
                          <AvatarFallback>
                            <PlatformIcon platform={account.platform as ExtendedPlatform} size="sm" />
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0 max-md:min-w-[10rem]">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium truncate">
                              {account.platform_username || "Unknown"}
                            </span>
                            <PlatformIcon platform={account.platform as ExtendedPlatform} size="xs" />
                            {(() => {
                              const cat = getPlatformScheduleCategory(account.platform);
                              return (
                                <Badge className={`text-[10px] h-4 px-1 ${cat.color}`}>
                                  {cat.interval}
                                </Badge>
                              );
                            })()}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {account.user_email || account.user_id}
                          </p>
                        </div>
                        
                        {/* Status Badge */}
                        <div className="w-32 text-end">
                          {getStatusBadge(account.status)}
                          <div className="mt-1 text-xs text-muted-foreground">
                            {account.token_expires_at ? (
                              account.status === "expired" || account.status === "needs_reauth" ? (
                                <span className="text-red-500">
                                  {account.status === "needs_reauth" ? "Reconnect" : `Expired ${formatDistanceToNow(new Date(account.token_expires_at))} ago`}
                                </span>
                              ) : (
                                <>Expires {formatDistanceToNow(new Date(account.token_expires_at), { addSuffix: true })}</>
                              )
                            ) : (
                              "No expiry set"
                            )}
                          </div>
                        </div>

                        {/* Failure Count & Error */}
                        <div className="w-32 text-end">
                          {account.failure_count > 0 && (
                            <div className="flex items-center gap-1 justify-end text-red-500 text-sm">
                              <AlertCircle className="w-3 h-3" />
                              {account.failure_count} failure{account.failure_count > 1 ? "s" : ""}
                            </div>
                          )}
                          {account.last_refresh_error && (
                            <div className="text-xs text-muted-foreground truncate max-w-[120px]" title={account.last_refresh_error}>
                              {account.last_refresh_error}
                            </div>
                          )}
                        </div>
                        
                        {/* Last Refresh Attempt */}
                        <div className="w-28 text-end text-xs text-muted-foreground">
                          <div className="flex items-center gap-1 justify-end">
                            <Timer className="w-3 h-3" />
                            Attempt
                          </div>
                          <div>
                            {account.last_refresh_attempt_at 
                              ? formatDistanceToNow(new Date(account.last_refresh_attempt_at), { addSuffix: true })
                              : "Never"
                            }
                          </div>
                        </div>
                        
                        {/* Last Updated */}
                        <div className="w-28 text-end text-xs text-muted-foreground">
                          <div className="flex items-center gap-1 justify-end">
                            <Clock className="w-3 h-3" />
                            Updated
                          </div>
                          <div>
                            {account.lastRefreshed 
                              ? formatDistanceToNow(new Date(account.lastRefreshed), { addSuffix: true })
                              : "Never"
                            }
                          </div>
                        </div>

                        {/* Alerts Toggle */}
                        <div className="flex items-center gap-2 w-24 justify-center">
                          <Switch
                            checked={!account.alerts_snoozed}
                            onCheckedChange={(checked) => 
                              toggleSnoozeMutation.mutate({ accountId: account.id, snoozed: !checked })
                            }
                            disabled={toggleSnoozeMutation.isPending}
                            className={!account.alerts_snoozed ? "data-[state=checked]:bg-green-500" : ""}
                          />
                          <span className="text-xs">
                            {account.alerts_snoozed ? (
                              <BellOff className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <Bell className="w-4 h-4 text-green-500" />
                            )}
                          </span>
                        </div>

                        {/* Actions */}
                        <div className="w-32 flex items-center justify-center gap-1">
                          {/* Force Refresh Button - available for all accounts */}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => forceRefreshAccountMutation.mutate(account.id)}
                            disabled={forceRefreshAccountMutation.isPending}
                            className="text-xs h-7 px-2"
                            title="Force refresh token (bypasses cooldown)"
                          >
                            <PlayCircle className={`w-3 h-3 ${forceRefreshAccountMutation.isPending ? "animate-spin" : ""}`} />
                          </Button>

                          {/* Reset Button for needs_reauth accounts */}
                          {account.needs_reauth && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => resetAccountMutation.mutate(account.id)}
                              disabled={resetAccountMutation.isPending}
                              className="text-xs h-7 px-2"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Refresh History */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <History className="w-5 h-5" />
                  Refresh History
                </CardTitle>
                <CardDescription>Recent token refresh attempts and results</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={exportHistoryToCSV}
                  className="gap-1"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => cleanupHistoryMutation.mutate()}
                  disabled={cleanupHistoryMutation.isPending}
                  className="gap-1"
                >
                  <Trash2 className={`w-4 h-4 ${cleanupHistoryMutation.isPending ? "animate-spin" : ""}`} />
                  Cleanup Old
                </Button>
                <Button variant="outline" size="sm" onClick={() => refetchHistory()}>
                  <RefreshCw className={`w-4 h-4 ${historyLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Charts Section */}
            {refreshHistory.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                {/* Status Distribution Pie Chart */}
                <div className="p-4 border rounded-lg">
                  <h4 className="text-sm font-medium mb-3">Status Distribution</h4>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={(() => {
                            const statusCounts: Record<string, number> = {};
                            refreshHistory.forEach(entry => {
                              statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
                            });
                            return Object.entries(statusCounts).map(([name, value]) => ({ name, value }));
                          })()}
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={70}
                          paddingAngle={2}
                          dataKey="value"
                          label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                          labelLine={false}
                        >
                          {(() => {
                            const statusColors: Record<string, string> = {
                              refreshed: '#22c55e',
                              failed: '#ef4444',
                              error: '#dc2626',
                              skipped: '#6b7280',
                              already_refreshed: '#3b82f6',
                              cooldown: '#eab308',
                              needs_reauth: '#dc2626',
                            };
                            const statusCounts: Record<string, number> = {};
                            refreshHistory.forEach(entry => {
                              statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
                            });
                            return Object.keys(statusCounts).map((status, index) => (
                              <Cell key={`cell-${index}`} fill={statusColors[status] || '#6b7280'} />
                            ));
                          })()}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Hourly Trend Bar Chart */}
                <div className="p-4 border rounded-lg">
                  <h4 className="text-sm font-medium mb-3">Last 24 Hours Trend</h4>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={(() => {
                          const now = new Date();
                          const hourlyData: { hour: string; success: number; failed: number }[] = [];
                          
                          for (let i = 23; i >= 0; i--) {
                            const hourStart = startOfHour(subHours(now, i));
                            const hourEnd = startOfHour(subHours(now, i - 1));
                            
                            const hourEntries = refreshHistory.filter(entry => {
                              const entryTime = new Date(entry.created_at);
                              return entryTime >= hourStart && entryTime < hourEnd;
                            });
                            
                            hourlyData.push({
                              hour: format(hourStart, 'HH:mm'),
                              success: hourEntries.filter(e => e.status === 'refreshed' || e.status === 'already_refreshed').length,
                              failed: hourEntries.filter(e => e.status === 'failed' || e.status === 'error' || e.status === 'needs_reauth').length,
                            });
                          }
                          
                          return hourlyData;
                        })()}
                        margin={{ top: 5, right: 5, left: -20, bottom: 5 }}
                      >
                        <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={5} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Bar dataKey="success" stackId="a" fill="#22c55e" name="Success" />
                        <Bar dataKey="failed" stackId="a" fill="#ef4444" name="Failed" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-3 mb-4 p-3 bg-muted/30 rounded-lg">
              <Select value={historyPlatformFilter} onValueChange={setHistoryPlatformFilter}>
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder="Platform" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Platforms</SelectItem>
                  {[...new Set(refreshHistory.map(h => h.platform))].sort().map(p => (
                    <SelectItem key={p} value={p}>
                      <span className="capitalize">{getPlatformName(p as ExtendedPlatform)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={historyStatusFilter} onValueChange={setHistoryStatusFilter}>
                <SelectTrigger className="w-[130px] h-8 text-xs">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="refreshed">Refreshed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="skipped">Skipped</SelectItem>
                  <SelectItem value="already_refreshed">Already Refreshed</SelectItem>
                  <SelectItem value="cooldown">Cooldown</SelectItem>
                  <SelectItem value="needs_reauth">Needs Reauth</SelectItem>
                </SelectContent>
              </Select>

              <Select value={historyTriggerFilter} onValueChange={setHistoryTriggerFilter}>
                <SelectTrigger className="w-[120px] h-8 text-xs">
                  <SelectValue placeholder="Trigger" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Triggers</SelectItem>
                  <SelectItem value="cron">Cron</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="force">Force</SelectItem>
                </SelectContent>
              </Select>

              {(historyPlatformFilter !== 'all' || historyStatusFilter !== 'all' || historyTriggerFilter !== 'all') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    setHistoryPlatformFilter('all');
                    setHistoryStatusFilter('all');
                    setHistoryTriggerFilter('all');
                  }}
                >
                  Clear Filters
                </Button>
              )}

              <Badge variant="secondary" className="ms-auto text-xs">
                {(() => {
                  const filtered = refreshHistory.filter(entry => {
                    if (historyPlatformFilter !== 'all' && entry.platform !== historyPlatformFilter) return false;
                    if (historyStatusFilter !== 'all' && entry.status !== historyStatusFilter) return false;
                    if (historyTriggerFilter !== 'all' && entry.trigger_type !== historyTriggerFilter) return false;
                    return true;
                  });
                  return `${filtered.length} of ${refreshHistory.length} entries`;
                })()}
              </Badge>
            </div>

            <ScrollArea className="h-[350px] max-md:[&>[data-radix-scroll-area-viewport]]:!overflow-x-auto">
              {historyLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : refreshHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <History className="w-12 h-12 mb-3 opacity-50" />
                  <p>No refresh history yet</p>
                </div>
              ) : (
                <div className="divide-y">
                  {/* Header row */}
                  <div className="p-3 bg-muted/30 flex items-center gap-4 text-xs font-medium text-muted-foreground">
                    <span className="w-32">Time</span>
                    <span className="w-24">Platform</span>
                    <span className="flex-1 max-md:min-w-[10rem]">Account</span>
                    <span className="w-24">Status</span>
                    <span className="w-20">Trigger</span>
                    <span className="w-20">Category</span>
                    <span className="flex-1 max-md:min-w-[10rem]">Error</span>
                  </div>
                  
                  {refreshHistory
                    .filter(entry => {
                      if (historyPlatformFilter !== 'all' && entry.platform !== historyPlatformFilter) return false;
                      if (historyStatusFilter !== 'all' && entry.status !== historyStatusFilter) return false;
                      if (historyTriggerFilter !== 'all' && entry.trigger_type !== historyTriggerFilter) return false;
                      return true;
                    })
                    .map((entry) => (
                    <div key={entry.id} className="p-3 hover:bg-muted/50 transition-colors">
                      <div className="flex items-center gap-4 text-sm">
                        {/* Time */}
                        <div className="w-32 text-xs text-muted-foreground">
                          <div>{format(new Date(entry.created_at), "MMM d, HH:mm:ss")}</div>
                          <div className="text-[10px]">{formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}</div>
                        </div>

                        {/* Platform */}
                        <div className="w-24 flex items-center gap-1">
                          <PlatformIcon platform={entry.platform as ExtendedPlatform} size="xs" />
                          <span className="text-xs capitalize">{getPlatformName(entry.platform as ExtendedPlatform)}</span>
                        </div>

                        {/* Account */}
                        <div className="flex-1 truncate text-xs max-md:min-w-[10rem]">
                          {entry.platform_username || entry.account_id.slice(0, 8)}
                        </div>

                        {/* Status */}
                        <div className="w-24">
                          {entry.status === 'refreshed' && (
                            <Badge className="bg-green-500/10 text-green-500 border-green-500/30 text-[10px]">
                              <CheckCircle className="w-3 h-3 me-1" />Refreshed
                            </Badge>
                          )}
                          {entry.status === 'failed' && (
                            <Badge className="bg-red-500/10 text-red-500 border-red-500/30 text-[10px]">
                              <AlertCircle className="w-3 h-3 me-1" />Failed
                            </Badge>
                          )}
                          {entry.status === 'error' && (
                            <Badge className="bg-red-500/10 text-red-500 border-red-500/30 text-[10px]">
                              <AlertCircle className="w-3 h-3 me-1" />Error
                            </Badge>
                          )}
                          {entry.status === 'skipped' && (
                            <Badge variant="outline" className="text-[10px]">
                              <Clock className="w-3 h-3 me-1" />Skipped
                            </Badge>
                          )}
                          {entry.status === 'already_refreshed' && (
                            <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/30 text-[10px]">
                              <CheckCircle className="w-3 h-3 me-1" />Already
                            </Badge>
                          )}
                          {entry.status === 'cooldown' && (
                            <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30 text-[10px]">
                              <Timer className="w-3 h-3 me-1" />Cooldown
                            </Badge>
                          )}
                          {entry.status === 'needs_reauth' && (
                            <Badge className="bg-red-600/10 text-red-600 border-red-600/30 text-[10px]">
                              <RotateCcw className="w-3 h-3 me-1" />Reauth
                            </Badge>
                          )}
                        </div>

                        {/* Trigger */}
                        <div className="w-20">
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {entry.trigger_type}
                          </Badge>
                        </div>

                        {/* Category */}
                        <div className="w-20">
                          {entry.cron_category ? (
                            <Badge 
                              className={`text-[10px] ${
                                entry.cron_category === 'short' ? 'bg-orange-500/10 text-orange-500 border-orange-500/30' :
                                entry.cron_category === 'medium' ? 'bg-blue-500/10 text-blue-500 border-blue-500/30' :
                                'bg-green-500/10 text-green-500 border-green-500/30'
                              }`}
                            >
                              {entry.cron_category}
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">-</span>
                          )}
                        </div>

                        {/* Error */}
                        <div className="flex-1 text-xs text-red-500 truncate max-md:min-w-[10rem]" title={entry.error_message || undefined}>
                          {entry.error_message || '-'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
