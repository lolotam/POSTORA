import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { 
  Activity, 
  AlertTriangle, 
  Bell, 
  BellOff,
  Check, 
  CheckCircle2, 
  Clock, 
  Database, 
  Eye,
  Heart, 
  Loader2, 
  Pause,
  Play,
  Plus, 
  RefreshCw, 
  Server, 
  Settings2, 
  Trash2, 
  TrendingDown, 
  TrendingUp,
  XCircle,
  Zap,
  BarChart3,
  Timer,
  Gauge,
  Hash
} from "lucide-react";
import { format, formatDistanceToNow, subHours } from "date-fns";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell, BarChart, Bar, Legend } from "recharts";
import { UnmatchedObservationsPanel } from "@/features/webhook-observability";

interface AlertConfig {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  metric_type: string | null;
  metric_name: string | null;
  threshold_value: number;
  threshold_operator: string;
  time_window_minutes: number;
  notification_channels: string[];
  notification_emails: string[];
  webhook_url: string | null;
  cooldown_minutes: number;
  last_triggered_at: string | null;
  is_active: boolean;
  created_at: string;
}

interface AlertHistory {
  id: string;
  alert_config_id: string | null;
  alert_name: string;
  trigger_type: string;
  triggered_value: number;
  threshold_value: number;
  metric_type: string | null;
  metric_name: string | null;
  details: Record<string, any>;
  notification_sent: boolean;
  notification_channel: string | null;
  severity: string;
  is_resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

interface HealthSnapshot {
  id: string;
  overall_health_score: number;
  edge_functions_health: number | null;
  database_health: number | null;
  token_health: number | null;
  cron_health: number | null;
  active_errors_count: number;
  failed_functions_count: number;
  slow_queries_count: number;
  unhealthy_tokens_count: number;
  metrics_breakdown: Record<string, any>;
  captured_at: string;
}

interface EdgeFunctionMetric {
  function_name: string;
  total_calls: number;
  success_count: number;
  error_count: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  min_duration_ms: number;
  success_rate: number;
  last_called_at: string;
}

const TRIGGER_TYPES = [
  { value: "error_rate", label: "Error Rate (%)", icon: AlertTriangle, description: "Alert when error percentage exceeds threshold" },
  { value: "response_time", label: "Response Time (ms)", icon: Timer, description: "Alert when average response time exceeds threshold" },
  { value: "function_failure", label: "Function Failure", icon: XCircle, description: "Alert when edge functions fail" },
  { value: "health_score", label: "Health Score", icon: Heart, description: "Alert when health score drops below threshold" },
  { value: "token_health", label: "Token Health", icon: Zap, description: "Alert when token health drops below threshold" },
  { value: "cron_failure", label: "Cron Job Failure", icon: Clock, description: "Alert when scheduled jobs fail" },
];

const OPERATORS = [
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "eq", label: "=" },
];

const SEVERITY_COLORS: Record<string, string> = {
  info: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  warning: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  critical: "bg-red-500/10 text-red-600 border-red-500/20",
};

const HEALTH_COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444"];
const FUNCTION_COLORS = ["#6366f1", "#22c55e", "#eab308", "#ef4444", "#8b5cf6", "#06b6d4", "#f43f5e", "#14b8a6"];

const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

export default function AdminObservability() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAddAlertOpen, setIsAddAlertOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [newAlert, setNewAlert] = useState({
    name: "",
    description: "",
    trigger_type: "error_rate",
    threshold_value: 10,
    threshold_operator: "gte",
    time_window_minutes: 5,
    cooldown_minutes: 30,
    notification_emails: "dr.vet.waleedtam@gmail.com",
    slack_webhook_url: "",
    use_slack: false,
  });

  // Fetch alert configurations
  const { data: alertConfigs = [], isLoading: loadingConfigs } = useQuery({
    queryKey: ["observability-alert-configs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("observability_alert_configs")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as AlertConfig[];
    },
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL : false,
  });

  // Fetch alert history
  const { data: alertHistory = [], isLoading: loadingHistory } = useQuery({
    queryKey: ["observability-alert-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("observability_alert_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as AlertHistory[];
    },
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL : false,
  });

  // Fetch latest health snapshot
  const { data: latestHealth, isLoading: loadingHealth, refetch: refetchHealth } = useQuery({
    queryKey: ["observability-health-latest"],
    queryFn: async () => {
      setLastRefreshed(new Date());
      const { data, error } = await supabase
        .from("observability_health_snapshots")
        .select("*")
        .order("captured_at", { ascending: false })
        .limit(1)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data as HealthSnapshot | null;
    },
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL : false,
  });

  // Fetch health history for chart
  const { data: healthHistory = [] } = useQuery({
    queryKey: ["observability-health-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("observability_health_snapshots")
        .select("*")
        .gte("captured_at", subHours(new Date(), 24).toISOString())
        .order("captured_at", { ascending: true });
      if (error) throw error;
      return data as HealthSnapshot[];
    },
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL : false,
  });

  // Fetch edge function performance metrics
  const { data: functionMetrics = [], isLoading: loadingFunctionMetrics } = useQuery({
    queryKey: ["observability-function-metrics"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("observability_metrics")
        .select("*")
        .eq("metric_type", "edge_function")
        .order("window_end", { ascending: false });
      if (error) throw error;
      
      // Group by function name and calculate aggregates
      const metricsMap = new Map<string, EdgeFunctionMetric>();
      
      for (const metric of data || []) {
        const name = metric.metric_name;
        const existing = metricsMap.get(name);
        
        if (existing) {
          existing.total_calls += metric.total_count;
          existing.success_count += metric.success_count;
          existing.error_count += metric.error_count;
          existing.avg_duration_ms = (existing.avg_duration_ms + (metric.avg_duration_ms || 0)) / 2;
          existing.max_duration_ms = Math.max(existing.max_duration_ms, metric.max_duration_ms || 0);
          existing.min_duration_ms = Math.min(existing.min_duration_ms, metric.min_duration_ms || Infinity);
          if (new Date(metric.window_end) > new Date(existing.last_called_at)) {
            existing.last_called_at = metric.window_end;
          }
        } else {
          metricsMap.set(name, {
            function_name: name,
            total_calls: metric.total_count,
            success_count: metric.success_count,
            error_count: metric.error_count,
            avg_duration_ms: metric.avg_duration_ms || 0,
            max_duration_ms: metric.max_duration_ms || 0,
            min_duration_ms: metric.min_duration_ms || 0,
            success_rate: 0,
            last_called_at: metric.window_end,
          });
        }
      }
      
      // Calculate success rates
      const metrics = Array.from(metricsMap.values()).map(m => ({
        ...m,
        success_rate: m.total_calls > 0 ? Math.round((m.success_count / m.total_calls) * 100) : 100,
      }));
      
      return metrics.sort((a, b) => b.total_calls - a.total_calls);
    },
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL : false,
  });

  // Auto-refresh effect to update lastRefreshed timestamp
  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(() => {
        setLastRefreshed(new Date());
      }, AUTO_REFRESH_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  // Toggle alert active status
  const toggleAlertMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("observability_alert_configs")
        .update({ is_active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["observability-alert-configs"] });
      toast({ title: "Alert updated" });
    },
    onError: (error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Delete alert
  const deleteAlertMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("observability_alert_configs")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["observability-alert-configs"] });
      toast({ title: "Alert deleted" });
    },
    onError: (error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Create new alert
  const createAlertMutation = useMutation({
    mutationFn: async () => {
      const channels = ["email"];
      if (newAlert.use_slack && newAlert.slack_webhook_url) {
        channels.push("slack");
      }
      
      const { error } = await supabase
        .from("observability_alert_configs")
        .insert({
          name: newAlert.name,
          description: newAlert.description || null,
          trigger_type: newAlert.trigger_type,
          threshold_value: newAlert.threshold_value,
          threshold_operator: newAlert.threshold_operator,
          time_window_minutes: newAlert.time_window_minutes,
          cooldown_minutes: newAlert.cooldown_minutes,
          notification_emails: newAlert.notification_emails.split(",").map(e => e.trim()),
          notification_channels: channels,
          webhook_url: newAlert.use_slack ? newAlert.slack_webhook_url : null,
          is_active: true,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["observability-alert-configs"] });
      setIsAddAlertOpen(false);
      setNewAlert({
        name: "",
        description: "",
        trigger_type: "error_rate",
        threshold_value: 10,
        threshold_operator: "gte",
        time_window_minutes: 5,
        cooldown_minutes: 30,
        notification_emails: "dr.vet.waleedtam@gmail.com",
        slack_webhook_url: "",
        use_slack: false,
      });
      toast({ title: "Alert created" });
    },
    onError: (error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Resolve alert
  const resolveAlertMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("observability_alert_history")
        .update({ is_resolved: true, resolved_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["observability-alert-history"] });
      toast({ title: "Alert resolved" });
    },
  });

  // Calculate stats
  const activeAlerts = alertHistory.filter(a => !a.is_resolved).length;
  const criticalAlerts = alertHistory.filter(a => !a.is_resolved && a.severity === "critical").length;
  const activeConfigs = alertConfigs.filter(c => c.is_active).length;

  const getHealthColor = (score: number | null) => {
    if (score === null) return "text-muted-foreground";
    if (score >= 80) return "text-green-500";
    if (score >= 60) return "text-yellow-500";
    if (score >= 40) return "text-orange-500";
    return "text-red-500";
  };

  const getHealthBgColor = (score: number | null) => {
    if (score === null) return "bg-muted";
    if (score >= 80) return "bg-green-500/10";
    if (score >= 60) return "bg-yellow-500/10";
    if (score >= 40) return "bg-orange-500/10";
    return "bg-red-500/10";
  };

  // Prepare chart data
  const healthChartData = healthHistory.map(h => ({
    time: format(new Date(h.captured_at), "HH:mm"),
    overall: h.overall_health_score,
    functions: h.edge_functions_health || 0,
    database: h.database_health || 0,
    tokens: h.token_health || 0,
  }));

  // Pie chart data for active alerts by severity
  const alertsBySeverity = [
    { name: "Critical", value: alertHistory.filter(a => !a.is_resolved && a.severity === "critical").length, color: "#ef4444" },
    { name: "Warning", value: alertHistory.filter(a => !a.is_resolved && a.severity === "warning").length, color: "#eab308" },
    { name: "Info", value: alertHistory.filter(a => !a.is_resolved && a.severity === "info").length, color: "#3b82f6" },
  ].filter(d => d.value > 0);

  // Prepare function performance chart data
  const functionChartData = functionMetrics.slice(0, 8).map((m, i) => ({
    name: m.function_name.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase()).slice(0, 15),
    calls: m.total_calls,
    success: m.success_count,
    errors: m.error_count,
    avgTime: Math.round(m.avg_duration_ms),
    successRate: m.success_rate,
  }));

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="w-6 h-6 text-primary" />
              Observability
            </h2>
            <p className="text-muted-foreground">Monitor system health, metrics, and configure alerts</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Auto-refresh toggle */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Auto-refresh</span>
              <Button
                variant={autoRefresh ? "default" : "outline"}
                size="sm"
                onClick={() => setAutoRefresh(!autoRefresh)}
                className="gap-1"
              >
                {autoRefresh ? (
                  <>
                    <Play className="w-3 h-3" />
                    On
                  </>
                ) : (
                  <>
                    <Pause className="w-3 h-3" />
                    Off
                  </>
                )}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              Last updated: {format(lastRefreshed, "HH:mm:ss")}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refetchHealth();
                queryClient.invalidateQueries({ queryKey: ["observability-alert-history"] });
                queryClient.invalidateQueries({ queryKey: ["observability-function-metrics"] });
                setLastRefreshed(new Date());
              }}
            >
              <RefreshCw className="w-4 h-4 me-2" />
              Refresh Now
            </Button>
          </div>
        </div>

        {/* Health Overview Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className={`${getHealthBgColor(latestHealth?.overall_health_score ?? null)}`}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Overall Health</p>
                  <p className={`text-3xl font-bold ${getHealthColor(latestHealth?.overall_health_score ?? null)}`}>
                    {latestHealth?.overall_health_score ?? "--"}%
                  </p>
                </div>
                <Gauge className={`w-10 h-10 ${getHealthColor(latestHealth?.overall_health_score ?? null)}`} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Alerts</p>
                  <p className={`text-3xl font-bold ${activeAlerts > 0 ? "text-red-500" : "text-green-500"}`}>
                    {activeAlerts}
                  </p>
                </div>
                {activeAlerts > 0 ? (
                  <AlertTriangle className="w-10 h-10 text-red-500" />
                ) : (
                  <CheckCircle2 className="w-10 h-10 text-green-500" />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Critical Issues</p>
                  <p className={`text-3xl font-bold ${criticalAlerts > 0 ? "text-red-500" : "text-green-500"}`}>
                    {criticalAlerts}
                  </p>
                </div>
                <XCircle className={`w-10 h-10 ${criticalAlerts > 0 ? "text-red-500" : "text-muted-foreground"}`} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Rules</p>
                  <p className="text-3xl font-bold">{activeConfigs}</p>
                </div>
                <Bell className="w-10 h-10 text-primary" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Health Breakdown */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${getHealthBgColor(latestHealth?.edge_functions_health ?? null)}`}>
                  <Zap className={`w-5 h-5 ${getHealthColor(latestHealth?.edge_functions_health ?? null)}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Edge Functions</p>
                  <p className={`text-lg font-semibold ${getHealthColor(latestHealth?.edge_functions_health ?? null)}`}>
                    {latestHealth?.edge_functions_health ?? "--"}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${getHealthBgColor(latestHealth?.database_health ?? null)}`}>
                  <Database className={`w-5 h-5 ${getHealthColor(latestHealth?.database_health ?? null)}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Database</p>
                  <p className={`text-lg font-semibold ${getHealthColor(latestHealth?.database_health ?? null)}`}>
                    {latestHealth?.database_health ?? "--"}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${getHealthBgColor(latestHealth?.token_health ?? null)}`}>
                  <Server className={`w-5 h-5 ${getHealthColor(latestHealth?.token_health ?? null)}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Token Health</p>
                  <p className={`text-lg font-semibold ${getHealthColor(latestHealth?.token_health ?? null)}`}>
                    {latestHealth?.token_health ?? "--"}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${getHealthBgColor(latestHealth?.cron_health ?? null)}`}>
                  <Clock className={`w-5 h-5 ${getHealthColor(latestHealth?.cron_health ?? null)}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Cron Jobs</p>
                  <p className={`text-lg font-semibold ${getHealthColor(latestHealth?.cron_health ?? null)}`}>
                    {latestHealth?.cron_health ?? "--"}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Health Chart */}
        {healthChartData.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BarChart3 className="w-5 h-5" />
                Health Trend (24h)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={healthChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="time" className="text-xs" />
                    <YAxis domain={[0, 100]} className="text-xs" />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: "hsl(var(--card))", 
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px"
                      }} 
                    />
                    <Area type="monotone" dataKey="overall" stroke="#22c55e" fill="#22c55e" fillOpacity={0.2} name="Overall" />
                    <Area type="monotone" dataKey="functions" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} name="Functions" />
                    <Area type="monotone" dataKey="tokens" stroke="#eab308" fill="#eab308" fillOpacity={0.1} name="Tokens" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Edge Function Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Edge Function Performance
            </CardTitle>
            <CardDescription>Individual function execution times, success rates, and error patterns</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingFunctionMetrics ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : functionMetrics.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Zap className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No function metrics collected yet</p>
                <p className="text-sm">Metrics will appear after functions are executed</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Function Performance Chart */}
                {functionChartData.length > 0 && (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={functionChartData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis type="number" />
                        <YAxis dataKey="name" type="category" width={100} className="text-xs" />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: "hsl(var(--card))", 
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "8px"
                          }}
                          formatter={(value: number, name: string) => {
                            if (name === "calls") return [value, "Total Calls"];
                            if (name === "success") return [value, "Successful"];
                            if (name === "errors") return [value, "Errors"];
                            return [value, name];
                          }}
                        />
                        <Legend />
                        <Bar dataKey="success" stackId="a" fill="#22c55e" name="Success" />
                        <Bar dataKey="errors" stackId="a" fill="#ef4444" name="Errors" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Function Details Table */}
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Function</TableHead>
                        <TableHead className="text-end">Total Calls</TableHead>
                        <TableHead className="text-end">Success Rate</TableHead>
                        <TableHead className="text-end">Avg Time</TableHead>
                        <TableHead className="text-end">Max Time</TableHead>
                        <TableHead className="text-end">Errors</TableHead>
                        <TableHead>Last Called</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {functionMetrics.map((metric) => (
                        <TableRow key={metric.function_name}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <Zap className="w-4 h-4 text-primary" />
                              {metric.function_name}
                            </div>
                          </TableCell>
                          <TableCell className="text-end">{metric.total_calls.toLocaleString()}</TableCell>
                          <TableCell className="text-end">
                            <Badge 
                              variant="secondary" 
                              className={
                                metric.success_rate >= 95 ? "bg-green-500/10 text-green-600" :
                                metric.success_rate >= 80 ? "bg-yellow-500/10 text-yellow-600" :
                                "bg-red-500/10 text-red-600"
                              }
                            >
                              {metric.success_rate}%
                            </Badge>
                          </TableCell>
                          <TableCell className="text-end">{Math.round(metric.avg_duration_ms)}ms</TableCell>
                          <TableCell className="text-end">
                            <span className={metric.max_duration_ms > 5000 ? "text-red-500" : ""}>
                              {Math.round(metric.max_duration_ms)}ms
                            </span>
                          </TableCell>
                          <TableCell className="text-end">
                            {metric.error_count > 0 ? (
                              <Badge variant="destructive">{metric.error_count}</Badge>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDistanceToNow(new Date(metric.last_called_at), { addSuffix: true })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tabs for Alerts */}
        <Tabs defaultValue="alerts" className="space-y-4">
          <TabsList>
            <TabsTrigger value="alerts" className="gap-2">
              <AlertTriangle className="w-4 h-4" />
              Alert History
              {activeAlerts > 0 && (
                <Badge variant="destructive" className="ms-1 h-5 px-1.5">
                  {activeAlerts}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="rules" className="gap-2">
              <Settings2 className="w-4 h-4" />
              Alert Rules
            </TabsTrigger>
          </TabsList>

          {/* Alert History Tab */}
          <TabsContent value="alerts" className="space-y-4">
            {/* Inbound events Postora received but could not route to any account. */}
            <UnmatchedObservationsPanel />

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Recent Alerts</CardTitle>
                <CardDescription>View and manage triggered alerts</CardDescription>
              </CardHeader>
              <CardContent>
                {loadingHistory ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </div>
                ) : alertHistory.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-green-500" />
                    <p className="font-medium">No alerts triggered</p>
                    <p className="text-sm">Your system is running smoothly</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[400px]">
                    <div className="space-y-3">
                      {alertHistory.map((alert) => (
                        <div
                          key={alert.id}
                          className={`p-4 rounded-lg border ${
                            alert.is_resolved 
                              ? "bg-muted/30 border-muted" 
                              : SEVERITY_COLORS[alert.severity] || "bg-card"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium">{alert.alert_name}</span>
                                <Badge variant="outline" className="text-xs">
                                  {alert.trigger_type.replace(/_/g, " ")}
                                </Badge>
                                {alert.is_resolved ? (
                                  <Badge variant="secondary" className="text-xs bg-green-500/10 text-green-600">
                                    <Check className="w-3 h-3 me-1" />
                                    Resolved
                                  </Badge>
                                ) : (
                                  <Badge variant="destructive" className="text-xs">
                                    Active
                                  </Badge>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                Triggered: {alert.triggered_value} (threshold: {alert.threshold_value})
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {formatDistanceToNow(new Date(alert.created_at), { addSuffix: true })}
                                {alert.metric_name && ` • ${alert.metric_name}`}
                              </p>
                            </div>
                            {!alert.is_resolved && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => resolveAlertMutation.mutate(alert.id)}
                                disabled={resolveAlertMutation.isPending}
                              >
                                <Check className="w-4 h-4 me-1" />
                                Resolve
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Alert Rules Tab */}
          <TabsContent value="rules" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">Alert Rules</CardTitle>
                    <CardDescription>Configure when to receive notifications</CardDescription>
                  </div>
                  <Dialog open={isAddAlertOpen} onOpenChange={setIsAddAlertOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm">
                        <Plus className="w-4 h-4 me-2" />
                        Add Rule
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-lg">
                      <DialogHeader>
                        <DialogTitle>Create Alert Rule</DialogTitle>
                        <DialogDescription>
                          Configure when you want to be notified about system issues
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Alert Name</Label>
                          <Input
                            placeholder="e.g., High Error Rate Alert"
                            value={newAlert.name}
                            onChange={(e) => setNewAlert(prev => ({ ...prev, name: e.target.value }))}
                          />
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Description (optional)</Label>
                          <Textarea
                            placeholder="Describe when this alert should fire..."
                            value={newAlert.description}
                            onChange={(e) => setNewAlert(prev => ({ ...prev, description: e.target.value }))}
                            rows={2}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Trigger Type</Label>
                          <Select
                            value={newAlert.trigger_type}
                            onValueChange={(value) => setNewAlert(prev => ({ ...prev, trigger_type: value }))}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TRIGGER_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  <div className="flex items-center gap-2">
                                    <type.icon className="w-4 h-4" />
                                    {type.label}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Operator</Label>
                            <Select
                              value={newAlert.threshold_operator}
                              onValueChange={(value) => setNewAlert(prev => ({ ...prev, threshold_operator: value }))}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {OPERATORS.map((op) => (
                                  <SelectItem key={op.value} value={op.value}>
                                    {op.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          
                          <div className="space-y-2">
                            <Label>Threshold</Label>
                            <Input
                              type="number"
                              value={newAlert.threshold_value}
                              onChange={(e) => setNewAlert(prev => ({ ...prev, threshold_value: parseFloat(e.target.value) || 0 }))}
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Time Window (min)</Label>
                            <Input
                              type="number"
                              value={newAlert.time_window_minutes}
                              onChange={(e) => setNewAlert(prev => ({ ...prev, time_window_minutes: parseInt(e.target.value) || 5 }))}
                            />
                          </div>
                          
                          <div className="space-y-2">
                            <Label>Cooldown (min)</Label>
                            <Input
                              type="number"
                              value={newAlert.cooldown_minutes}
                              onChange={(e) => setNewAlert(prev => ({ ...prev, cooldown_minutes: parseInt(e.target.value) || 30 }))}
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>Notification Emails</Label>
                          <Input
                            placeholder="email1@example.com, email2@example.com"
                            value={newAlert.notification_emails}
                            onChange={(e) => setNewAlert(prev => ({ ...prev, notification_emails: e.target.value }))}
                          />
                          <p className="text-xs text-muted-foreground">Comma-separated email addresses</p>
                        </div>

                        {/* Slack Notifications */}
                        <div className="space-y-3 pt-2 border-t">
                          <div className="flex items-center justify-between">
                            <Label className="flex items-center gap-2">
                              <Hash className="w-4 h-4" />
                              Slack Notifications
                            </Label>
                            <Switch
                              checked={newAlert.use_slack}
                              onCheckedChange={(checked) => setNewAlert(prev => ({ ...prev, use_slack: checked }))}
                            />
                          </div>
                          {newAlert.use_slack && (
                            <div className="space-y-2">
                              <Label>Slack Webhook URL</Label>
                              <Input
                                placeholder="https://hooks.slack.com/services/..."
                                value={newAlert.slack_webhook_url}
                                onChange={(e) => setNewAlert(prev => ({ ...prev, slack_webhook_url: e.target.value }))}
                              />
                              <p className="text-xs text-muted-foreground">
                                Create an incoming webhook at your Slack workspace settings
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setIsAddAlertOpen(false)}>
                          Cancel
                        </Button>
                        <Button 
                          onClick={() => createAlertMutation.mutate()}
                          disabled={!newAlert.name || createAlertMutation.isPending}
                        >
                          {createAlertMutation.isPending ? (
                            <Loader2 className="w-4 h-4 me-2 animate-spin" />
                          ) : null}
                          Create Rule
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent>
                {loadingConfigs ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </div>
                ) : alertConfigs.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Bell className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No alert rules configured</p>
                    <p className="text-sm">Create a rule to start receiving notifications</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {alertConfigs.map((config) => {
                      const triggerType = TRIGGER_TYPES.find(t => t.value === config.trigger_type);
                      const TriggerIcon = triggerType?.icon || AlertTriangle;
                      
                      return (
                        <div
                          key={config.id}
                          className={`p-4 rounded-lg border ${
                            config.is_active ? "bg-card" : "bg-muted/30 opacity-60"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3">
                              <div className={`p-2 rounded-lg ${config.is_active ? "bg-primary/10" : "bg-muted"}`}>
                                <TriggerIcon className={`w-5 h-5 ${config.is_active ? "text-primary" : "text-muted-foreground"}`} />
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{config.name}</span>
                                  {!config.is_active && (
                                    <Badge variant="secondary" className="text-xs">Paused</Badge>
                                  )}
                                </div>
                                {config.description && (
                                  <p className="text-sm text-muted-foreground mt-0.5">{config.description}</p>
                                )}
                                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                                  <span>
                                    Trigger: {OPERATORS.find(o => o.value === config.threshold_operator)?.label} {config.threshold_value}
                                  </span>
                                  <span>•</span>
                                  <span>Window: {config.time_window_minutes}m</span>
                                  <span>•</span>
                                  <span>Cooldown: {config.cooldown_minutes}m</span>
                                  {config.notification_channels.includes("slack") && (
                                    <>
                                      <span>•</span>
                                      <Badge variant="outline" className="h-5 text-xs gap-1">
                                        <Hash className="w-3 h-3" />
                                        Slack
                                      </Badge>
                                    </>
                                  )}
                                </div>
                                {config.last_triggered_at && (
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Last triggered: {formatDistanceToNow(new Date(config.last_triggered_at), { addSuffix: true })}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={config.is_active}
                                onCheckedChange={(checked) => toggleAlertMutation.mutate({ id: config.id, is_active: checked })}
                                disabled={toggleAlertMutation.isPending}
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                onClick={() => deleteAlertMutation.mutate(config.id)}
                                disabled={deleteAlertMutation.isPending}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
