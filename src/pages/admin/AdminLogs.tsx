import React, { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  RefreshCw, 
  Search, 
  Play, 
  Pause, 
  AlertCircle, 
  CheckCircle, 
  Info, 
  AlertTriangle,
  Clock,
  Zap,
  Database,
  Shield,
  Globe,
  Trash2,
  User,
  Sparkles,
  Copy,
  Check,
  Loader2,
  Lightbulb,
  Target,
  MessageSquare,
  Timer,
  Activity,
  ChevronDown
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

// Log categories
const LOG_CATEGORIES = [
  { value: "all", label: "All Logs", icon: Globe },
  { value: "token", label: "Token Refresh", icon: Shield },
  { value: "edge", label: "Edge Functions", icon: Zap },
  { value: "post", label: "Posts", icon: Database },
  { value: "auth", label: "Authentication", icon: Shield },
  { value: "system", label: "System", icon: Globe },
  { value: "ai", label: "AI Calls", icon: Sparkles },
] as const;

type LogLevel = "info" | "warn" | "error" | "debug";

interface SystemLog {
  id: string;
  created_at: string;
  level: LogLevel;
  category: string;
  source: string;
  message: string;
  user_id: string | null;
  metadata: Record<string, unknown>;
  userEmail?: string;
  userFullName?: string | null;
}

interface CronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  active: boolean;
  command: string;
  nodename: string;
  nodeport: number;
  database: string;
  username: string;
}

const ERROR_KEYS = ["error", "errorMessage", "error_message", "reason", "last_error"];
const KNOWN_KEYS = [
  { key: "platform", label: "Platform" },
  { key: "account", label: "Account" },
  { key: "accountId", label: "Account ID" },
  { key: "account_id", label: "Account ID" },
  { key: "social_account_id", label: "Account ID" },
  { key: "url", label: "URL" },
  { key: "endpoint", label: "Endpoint" },
  { key: "status_code", label: "Status Code" },
  { key: "statusCode", label: "Status Code" },
  { key: "duration", label: "Duration" },
  { key: "duration_ms", label: "Duration" },
  { key: "executionTime", label: "Duration" },
  { key: "postId", label: "Post ID" },
  { key: "post_id", label: "Post ID" },
  { key: "mediaUrl", label: "Media URL" },
  { key: "media_url", label: "Media URL" },
  { key: "response", label: "Response" },
  { key: "user_id", label: "User ID" },
  { key: "function_name", label: "Function" },
  { key: "method", label: "Method" },
  { key: "ip_address", label: "IP Address" },
  { key: "feature", label: "Feature" },
  { key: "model_used", label: "Model Used" },
  { key: "provider_used", label: "Provider" },
  { key: "tier_used", label: "Tier Used" },
  { key: "success", label: "Success" },
  { key: "tiers", label: "Tier Details" },
  { key: "user", label: "User" },
];

function isUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.startsWith("http://") || value.startsWith("https://");
}

function formatDuration(ms: unknown): string {
  const num = typeof ms === "string" ? parseFloat(ms) : typeof ms === "number" ? ms : NaN;
  if (isNaN(num)) return String(ms);
  if (num < 1000) return `${Math.round(num)}ms`;
  return `${(num / 1000).toFixed(2)}s`;
}

function formatValue(key: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground italic">null</span>;
  if (isUrl(value)) return <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-500 underline break-all">{value}</a>;
  if (key.includes("duration") || key === "executionTime") return formatDuration(value);
  if (key === "user" && typeof value === "object" && value !== null) {
    const u = value as Record<string, unknown>;
    const parts: string[] = [];
    if (u.email) parts.push(String(u.email));
    if (u.full_name) parts.push(String(u.full_name));
    if (u.plan) parts.push(`Plan: ${String(u.plan)}`);
    return parts.length > 0 ? parts.join(" · ") : JSON.stringify(value);
  }
  if (typeof value === "object") return <pre className="text-xs bg-muted rounded p-1 overflow-auto max-h-24">{JSON.stringify(value, null, 2)}</pre>;
  return String(value);
}

function renderMetadataDetails(metadata: Record<string, unknown>) {
  if (!metadata || Object.keys(metadata).length === 0) return null;

  const errorMessages: { key: string; value: string }[] = [];
  const knownFields: { label: string; key: string; value: unknown }[] = [];
  const usedKeys = new Set<string>();

  for (const ek of ERROR_KEYS) {
    if (metadata[ek]) {
      errorMessages.push({ key: ek, value: String(metadata[ek]) });
      usedKeys.add(ek);
    }
  }

  for (const { key, label } of KNOWN_KEYS) {
    if (metadata[key] !== undefined && !usedKeys.has(key)) {
      knownFields.push({ label, key, value: metadata[key] });
      usedKeys.add(key);
    }
  }

  const remainingKeys = Object.keys(metadata).filter((k) => !usedKeys.has(k));

  return (
    <div className="mt-2 space-y-2">
      {errorMessages.length > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 space-y-1">
          {errorMessages.map((em) => (
            <div key={em.key} className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <div>
                <span className="text-xs font-semibold text-red-500 uppercase">{em.key.replace(/_/g, " ")}: </span>
                <span className="text-sm text-red-400 break-all">{em.value}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {knownFields.length > 0 && (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {knownFields.map((f) => (
            <React.Fragment key={f.key}>
              <span className="text-muted-foreground font-medium">{f.label}</span>
              <span className="break-all">{formatValue(f.key, f.value)}</span>
            </React.Fragment>
          ))}
        </div>
      )}

      {remainingKeys.length > 0 && (
        <details>
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Raw details ({remainingKeys.length} fields)
          </summary>
          <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-auto max-h-40">
            {JSON.stringify(
              Object.fromEntries(remainingKeys.map((k) => [k, metadata[k]])),
              null,
              2
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

function getLevelIcon(level: LogLevel) {
  switch (level) {
    case "error":
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    case "warn":
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case "info":
      return <Info className="w-4 h-4 text-blue-500" />;
    default:
      return <CheckCircle className="w-4 h-4 text-green-500" />;
  }
}

function getLevelBadgeVariant(level: LogLevel): "default" | "secondary" | "destructive" | "outline" {
  switch (level) {
    case "error":
      return "destructive";
    case "warn":
      return "outline";
    default:
      return "secondary";
  }
}

// Human-readable cron schedule
function humanReadableSchedule(cron: string): string {
  const map: Record<string, string> = {
    "* * * * *": "Every minute",
    "*/2 * * * *": "Every 2 minutes",
    "*/3 * * * *": "Every 3 minutes",
    "*/5 * * * *": "Every 5 minutes",
    "*/10 * * * *": "Every 10 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
    "0 * * * *": "Every hour",
    "30 * * * *": "Every hour at :30",
    "0 */2 * * *": "Every 2 hours",
    "0 */3 * * *": "Every 3 hours",
    "0 */4 * * *": "Every 4 hours",
    "0 */6 * * *": "Every 6 hours",
    "30 */6 * * *": "Every 6 hours at :30",
    "0 */12 * * *": "Every 12 hours",
    "0 0 * * *": "Daily at midnight UTC",
    "0 9 * * *": "Daily at 9:00 AM UTC",
    "0 9 * * 1": "Weekly on Monday 9:00 AM UTC",
  };
  return map[cron] || cron;
}

// Extract function name from cron command
function extractFunctionName(command: string): string {
  // Try to extract from URL pattern like /functions/v1/function-name
  const urlMatch = command.match(/\/functions\/v1\/([a-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1];
  // Try net.http_post URL
  const httpMatch = command.match(/https?:\/\/[^/]+\/functions\/v1\/([a-z0-9-]+)/i);
  if (httpMatch) return httpMatch[1];
  // Fallback: return truncated command
  return command.length > 60 ? command.substring(0, 60) + "..." : command;
}

// Format job name to title case
function formatJobName(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface LogAnalysis {
  explanation: string;
  root_cause: string;
  lovable_prompt: string;
}

// ─── Cron Job Descriptions ─────────────────────────────────────────
const CRON_DESCRIPTIONS: Record<string, { description: string; workflow: string; files: string[] }> = {
  "process-scheduled-posts": {
    description: "Processes posts scheduled for publishing across all platforms",
    workflow: "1. Queries posts with status='pending' and scheduled_at <= now()\n2. For each post, checks if OAuth tokens are expiring and refreshes them (Facebook, TikTok, YouTube, Pinterest)\n3. Uses selected_account_ids from metadata to target specific accounts\n4. Calls the process-post edge function for each post\n5. Marks failed posts with status='failed'\n6. Logs completion summary with success/fail counts to system_logs",
    files: ["supabase/functions/process-scheduled-posts/index.ts", "supabase/functions/process-post/index.ts"],
  },
  "refresh-tokens": {
    description: "Proactively refreshes OAuth tokens before they expire",
    workflow: "1. Queries social_accounts for tokens expiring within a buffer window\n2. Calls platform-specific refresh endpoints (Facebook, TikTok, YouTube, Pinterest)\n3. Updates access_token, refresh_token, and token_expires_at in the database\n4. Marks accounts with needs_reauth=true if refresh fails repeatedly\n5. Logs refresh results and failures to system_logs",
    files: ["supabase/functions/refresh-tokens/index.ts", "supabase/functions/_shared/social-auth.ts"],
  },
  "process-scheduled-flags": {
    description: "Executes scheduled feature flag changes at their planned time",
    workflow: "1. Queries feature_flag_schedules with status='pending' and scheduled_at <= now()\n2. Updates the corresponding feature flag value in the database\n3. Logs the change to feature_flag_audit_log\n4. Marks the schedule entry as 'executed' with timestamp",
    files: ["supabase/functions/process-scheduled-flags/index.ts"],
  },
  "check-connection-health": {
    description: "Verifies social account connections are healthy and tokens valid",
    workflow: "1. Queries all active social_accounts\n2. Makes lightweight API calls to each platform to verify token validity\n3. Updates failure_count and last_refresh_error on failures\n4. Sets needs_reauth=true for accounts that consistently fail\n5. Logs health check results to system_logs",
    files: ["supabase/functions/check-connection-health/index.ts"],
  },
  "send-token-expiry-notifications": {
    description: "Sends email alerts when OAuth tokens are about to expire",
    workflow: "1. Queries social_accounts with tokens expiring soon\n2. Filters out accounts with alerts_snoozed=true\n3. Sends notification emails via Resend to affected users\n4. Updates last_alert_sent_at to prevent duplicate alerts",
    files: ["supabase/functions/send-token-expiry-notifications/index.ts"],
  },
  "send-expiry-reminders": {
    description: "Sends reminder emails for upcoming subscription expirations",
    workflow: "1. Queries user_subscriptions nearing their current_period_end\n2. Sends email reminders at configured intervals (e.g., 7 days, 1 day before)\n3. Uses email templates from email_templates table\n4. Logs sent reminders to email_log",
    files: ["supabase/functions/send-expiry-reminders/index.ts"],
  },
  "observability-collector": {
    description: "Aggregates system metrics and health data for the observability dashboard",
    workflow: "1. Collects metrics from edge_function_status, system_logs, and social_accounts\n2. Calculates health scores for edge functions, database, cron jobs, and tokens\n3. Inserts a new snapshot into observability_health_snapshots\n4. Aggregates time-windowed metrics into observability_metrics",
    files: ["supabase/functions/observability-collector/index.ts"],
  },
  "observability-alerts": {
    description: "Evaluates alert rules and triggers notifications when thresholds are breached",
    workflow: "1. Queries active alert configs from observability_alert_configs\n2. Evaluates each alert's metric against its threshold\n3. Respects cooldown periods to prevent alert storms\n4. Sends notifications via configured channels (email, webhook)\n5. Records alert history in observability_alert_history",
    files: ["supabase/functions/observability-alerts/index.ts"],
  },
  "process-scheduled-emails": {
    description: "Sends emails that were scheduled for later delivery",
    workflow: "1. Queries scheduled_emails with status='pending' and scheduled_at <= now()\n2. Sends each email via Resend API\n3. Updates status to 'sent' with sent_at timestamp\n4. Marks failed emails with error_message",
    files: ["supabase/functions/process-scheduled-emails/index.ts"],
  },
  "process-scheduled-blog-posts": {
    description: "Publishes blog posts at their scheduled time",
    workflow: "1. Queries blog_posts with status='scheduled' and scheduled_at <= now()\n2. Updates status to 'published'\n3. Triggers any associated notifications",
    files: ["supabase/functions/process-scheduled-blog-posts/index.ts"],
  },
  "cleanup-media": {
    description: "Removes orphaned media files and cleans up storage",
    workflow: "1. Identifies media_files not referenced by any post\n2. Deletes files from Supabase Storage or Cloudinary\n3. Removes database records for cleaned-up files\n4. Logs cleanup summary with counts",
    files: ["supabase/functions/cleanup-media/index.ts"],
  },
  "sync-user-quotas": {
    description: "Recalculates and synchronizes user usage quotas",
    workflow: "1. Queries usage data (posts, media uploads, AI credits) for each user\n2. Compares against subscription plan limits\n3. Updates quota counters in the database\n4. Resets periodic counters (daily/monthly) when appropriate",
    files: ["supabase/functions/sync-user-quotas/index.ts"],
  },
  "send-weekly-analytics": {
    description: "Sends weekly analytics summary emails to users",
    workflow: "1. Aggregates post performance data for the past week\n2. Generates per-user analytics summaries\n3. Renders email template with charts/stats\n4. Sends via Resend API\n5. Logs delivery status to email_log",
    files: ["supabase/functions/send-weekly-analytics/index.ts"],
  },
  "sync-resend-delivery-status": {
    description: "Synchronizes email delivery status from Resend",
    workflow: "1. Queries recent email_log entries with pending delivery status\n2. Checks Resend API for delivery/bounce/open events\n3. Updates email_log with opened_at, clicked_at, and error info",
    files: ["supabase/functions/sync-resend-delivery-status/index.ts"],
  },
  "notify-expiring-ai-overrides": {
    description: "Alerts users when their AI model preference overrides are about to expire",
    workflow: "1. Queries ai_model_preferences for entries nearing expiration\n2. Sends notification to affected users\n3. Cleans up expired overrides",
    files: ["supabase/functions/notify-expiring-ai-overrides/index.ts"],
  },
  "send-token-failure-alert": {
    description: "Sends immediate alerts when token refresh failures exceed threshold",
    workflow: "1. Queries social_accounts with high failure_count\n2. Sends urgent email to account owner\n3. Updates last_alert_sent_at to prevent spam",
    files: ["supabase/functions/send-token-failure-alert/index.ts"],
  },
};

// ─── Cron Operations Tab ───────────────────────────────────────────
function CronOperationsTab() {
  const queryClient = useQueryClient();
  const [expandedJobs, setExpandedJobs] = useState<Set<number>>(new Set());

  const { data: cronJobs = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-cron-jobs"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("manage-cron-jobs", {
        method: "GET",
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return (data?.jobs || []) as CronJob[];
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ jobid, active }: { jobid: number; active: boolean }) => {
      const { data, error } = await supabase.functions.invoke("manage-cron-jobs", {
        body: { jobid, active },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_, variables) => {
      toast.success(`Cron job ${variables.active ? "enabled" : "disabled"}`);
      queryClient.invalidateQueries({ queryKey: ["admin-cron-jobs"] });
    },
    onError: (error) => {
      toast.error("Failed to toggle cron job", { description: error.message });
    },
  });

  const activeCount = cronJobs.filter((j) => j.active).length;
  const inactiveCount = cronJobs.length - activeCount;

  const toggleExpand = (jobid: number) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(jobid)) next.delete(jobid);
      else next.add(jobid);
      return next;
    });
  };

  const getJobDescription = (jobname: string) => {
    const fnName = jobname.replace(/^invoke-/, "").replace(/-every-.*$/, "").replace(/-\d+[-]?(min|hour|minute|sec|day|week).*$/i, "");
    return CRON_DESCRIPTIONS[fnName] || CRON_DESCRIPTIONS[jobname] || null;
  };

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Timer className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{cronJobs.length}</p>
                <p className="text-xs text-muted-foreground">Total Jobs</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-500" />
              <div>
                <p className="text-2xl font-bold text-green-500">{activeCount}</p>
                <p className="text-xs text-muted-foreground">Active</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Pause className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{inactiveCount}</p>
                <p className="text-xs text-muted-foreground">Inactive</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Cron Jobs
          </h3>
          <p className="text-sm text-muted-foreground">Manage scheduled background tasks</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Cards */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : cronJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Timer className="w-12 h-12 mb-3 opacity-50" />
          <p>No cron jobs found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {cronJobs.map((job, index) => {
            const isExpanded = expandedJobs.has(job.jobid);
            const fnName = extractFunctionName(job.command);
            const desc = getJobDescription(job.jobname);

            return (
              <Card key={job.jobid} className="overflow-hidden">
                {/* Card Header - Clickable */}
                <div
                  className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => toggleExpand(job.jobid)}
                >
                  {/* Number Badge */}
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">
                    {index + 1}
                  </div>

                  {/* Main Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold">{formatJobName(job.jobname)}</p>
                      <Badge variant={job.active ? "default" : "secondary"} className="text-[10px]">
                        {job.active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {humanReadableSchedule(job.schedule)}
                      </span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {fnName}
                      </Badge>
                    </div>
                  </div>

                  {/* Toggle + Chevron */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Switch
                      checked={job.active}
                      disabled={toggleMutation.isPending}
                      onCheckedChange={(checked) => {
                        toggleMutation.mutate({ jobid: job.jobid, active: checked });
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t bg-muted/30 p-4 space-y-4">
                    {/* Description */}
                    {desc && (
                      <div>
                        <p className="text-sm font-medium mb-1 flex items-center gap-1.5">
                          <Info className="w-4 h-4 text-blue-500" />
                          Description
                        </p>
                        <p className="text-sm text-muted-foreground">{desc.description}</p>
                      </div>
                    )}

                    {/* Workflow */}
                    {desc && (
                      <div>
                        <p className="text-sm font-medium mb-1 flex items-center gap-1.5">
                          <Lightbulb className="w-4 h-4 text-yellow-500" />
                          How It Works
                        </p>
                        <div className="bg-muted rounded-lg p-3">
                          {desc.workflow.split("\n").map((step, i) => (
                            <p key={i} className="text-sm text-muted-foreground leading-relaxed">{step}</p>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Source Files */}
                    {desc && desc.files.length > 0 && (
                      <div>
                        <p className="text-sm font-medium mb-1 flex items-center gap-1.5">
                          <Database className="w-4 h-4 text-primary" />
                          Source Files
                        </p>
                        <div className="space-y-1">
                          {desc.files.map((file) => (
                            <p key={file} className="text-xs font-mono text-muted-foreground bg-muted rounded px-2 py-1">
                              📄 {file}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* System Details */}
                    <div>
                      <p className="text-sm font-medium mb-1 flex items-center gap-1.5">
                        <Target className="w-4 h-4 text-muted-foreground" />
                        System Details
                      </p>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="bg-muted rounded-lg p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-medium">Schedule</p>
                          <p className="text-xs font-mono">{job.schedule}</p>
                        </div>
                        <div className="bg-muted rounded-lg p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-medium">Database</p>
                          <p className="text-xs font-mono">{job.database}</p>
                        </div>
                        <div className="bg-muted rounded-lg p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-medium">Node</p>
                          <p className="text-xs font-mono">{job.nodename}:{job.nodeport}</p>
                        </div>
                        <div className="bg-muted rounded-lg p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-medium">Username</p>
                          <p className="text-xs font-mono">{job.username}</p>
                        </div>
                      </div>
                    </div>

                    {/* Raw Command */}
                    <div>
                      <p className="text-sm font-medium mb-1 flex items-center gap-1.5">
                        <MessageSquare className="w-4 h-4 text-muted-foreground" />
                        SQL Command
                      </p>
                      <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap break-all">
                        {job.command}
                      </pre>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────
export default function AdminLogs() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedLevel, setSelectedLevel] = useState("all");
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("all");
  const [analyzingLogId, setAnalyzingLogId] = useState<string | null>(null);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);

  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [showDeleteFilteredDialog, setShowDeleteFilteredDialog] = useState(false);

  const handleAnalyzeLog = useCallback(async (log: SystemLog) => {
    setAnalyzingLogId(log.id);
    try {
      const { data, error } = await supabase.functions.invoke('analyze-log', {
        body: { log },
      });
      if (error) throw error;
      if (data?.error) {
        toast.error('Analysis failed', { description: data.error });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin-log-analyses"] });
      toast.success('Log analyzed successfully');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error('Failed to analyze log', { description: msg });
    } finally {
      setAnalyzingLogId(null);
    }
  }, [queryClient]);

  const handleCopyPrompt = useCallback(async (logId: string, prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPromptId(logId);
      toast.success('Lovable prompt copied to clipboard');
      setTimeout(() => setCopiedPromptId(null), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  }, []);

  const { data: profilesMap = {} } = useQuery({
    queryKey: ["admin-log-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name");
      if (error) throw error;
      const map: Record<string, { email: string; full_name: string | null }> = {};
      (data || []).forEach((p) => { map[p.id] = { email: p.email, full_name: p.full_name }; });
      return map;
    },
  });

  const { data: userLogCounts = {} } = useQuery({
    queryKey: ["admin-log-user-counts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_logs")
        .select("user_id");
      if (error) throw error;
      const counts: Record<string, number> = { _total: 0, _system: 0 };
      (data || []).forEach((row) => {
        counts._total = (counts._total || 0) + 1;
        if (row.user_id) {
          counts[row.user_id] = (counts[row.user_id] || 0) + 1;
        } else {
          counts._system = (counts._system || 0) + 1;
        }
      });
      return counts;
    },
  });

  const { data: logs = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-system-logs", selectedCategory, selectedLevel, searchQuery, selectedUserId],
    queryFn: async () => {
      let query = supabase
        .from("system_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);

      if (selectedCategory !== "all") query = query.eq("category", selectedCategory);
      if (selectedLevel !== "all") query = query.eq("level", selectedLevel);
      if (searchQuery) query = query.or(`message.ilike.%${searchQuery}%,source.ilike.%${searchQuery}%`);
      if (selectedUserId !== "all") {
        if (selectedUserId === "system") {
          query = query.is("user_id", null);
        } else {
          query = query.eq("user_id", selectedUserId);
        }
      }

      const { data, error } = await query;
      if (error) throw error;

      return (data || []).map((log) => ({
        ...log,
        level: log.level as LogLevel,
        metadata: (log.metadata || {}) as Record<string, unknown>,
        userEmail: log.user_id ? profilesMap[log.user_id]?.email : undefined,
        userFullName: log.user_id ? profilesMap[log.user_id]?.full_name : undefined,
      })) as SystemLog[];
    },
    refetchInterval: isLiveMode ? 5000 : false,
  });

  const logIds = logs.map(l => l.id);
  const { data: analysesData = [] } = useQuery({
    queryKey: ["admin-log-analyses", logIds],
    queryFn: async () => {
      if (logIds.length === 0) return [];
      const { data, error } = await supabase
        .from("log_analyses" as any)
        .select("*")
        .in("log_id", logIds);
      if (error) throw error;
      return data || [];
    },
    enabled: logIds.length > 0,
  });

  const analysisResults = useMemo(() => {
    const map = new Map<string, LogAnalysis>();
    for (const a of analysesData as any[]) {
      map.set(a.log_id, {
        explanation: a.explanation,
        root_cause: a.root_cause,
        lovable_prompt: a.lovable_prompt,
      });
    }
    return map;
  }, [analysesData]);

  const clearOldLogsMutation = useMutation({
    mutationFn: async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { error } = await supabase
        .from("system_logs")
        .delete()
        .lt("created_at", thirtyDaysAgo.toISOString());
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Old logs cleared");
      queryClient.invalidateQueries({ queryKey: ["admin-system-logs"] });
    },
    onError: (error) => {
      toast.error("Failed to clear logs", { description: error.message });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      // Supabase has limits, so batch in chunks of 100
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { error } = await supabase
          .from("system_logs")
          .delete()
          .in("id", chunk);
        if (error) throw error;
      }
    },
    onSuccess: (_, ids) => {
      toast.success(`Deleted ${ids.length} log(s)`);
      setSelectedLogIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["admin-system-logs"] });
      queryClient.invalidateQueries({ queryKey: ["admin-log-user-counts"] });
    },
    onError: (error) => {
      toast.error("Failed to delete logs", { description: error.message });
    },
  });

  const deleteFilteredMutation = useMutation({
    mutationFn: async () => {
      let query = supabase.from("system_logs").delete();
      if (selectedCategory !== "all") query = query.eq("category", selectedCategory);
      if (selectedLevel !== "all") query = query.eq("level", selectedLevel);
      if (searchQuery) query = query.or(`message.ilike.%${searchQuery}%,source.ilike.%${searchQuery}%`);
      if (selectedUserId !== "all") {
        if (selectedUserId === "system") {
          query = query.is("user_id", null);
        } else {
          query = query.eq("user_id", selectedUserId);
        }
      }
      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Filtered logs deleted");
      setSelectedLogIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["admin-system-logs"] });
      queryClient.invalidateQueries({ queryKey: ["admin-log-user-counts"] });
    },
    onError: (error) => {
      toast.error("Failed to delete filtered logs", { description: error.message });
    },
  });

  const deleteAnalysisMutation = useMutation({
    mutationFn: async (logId: string) => {
      const { error } = await supabase.from("log_analyses").delete().eq("log_id", logId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Analysis deleted");
      queryClient.invalidateQueries({ queryKey: ["admin-log-analyses"] });
    },
    onError: (error: Error) => {
      toast.error("Failed to delete analysis", { description: error.message });
    },
  });

  const handleRefresh = () => {
    refetch();
    toast.success("Logs refreshed");
  };

  const toggleLiveMode = () => {
    setIsLiveMode(!isLiveMode);
    toast.info(isLiveMode ? "Live mode disabled" : "Live mode enabled - refreshing every 5s");
  };

  const toggleLogSelection = useCallback((id: string) => {
    setSelectedLogIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedLogIds.size === logs.length) {
      setSelectedLogIds(new Set());
    } else {
      setSelectedLogIds(new Set(logs.map(l => l.id)));
    }
  }, [logs, selectedLogIds.size]);

  const errorCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warn").length;
  const infoCount = logs.filter((l) => l.level === "info").length;
  const hasActiveFilters = selectedCategory !== "all" || selectedLevel !== "all" || searchQuery || selectedUserId !== "all";

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">System Logs</h2>
            <p className="text-muted-foreground">Monitor edge functions, token refresh, cron jobs, and system events</p>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="logs" className="space-y-4">
          <TabsList>
            <TabsTrigger value="logs">Log Entries</TabsTrigger>
            <TabsTrigger value="cron">Cron Operations</TabsTrigger>
          </TabsList>

          {/* Log Entries Tab */}
          <TabsContent value="logs" className="space-y-6">
            {/* Controls */}
            <div className="flex items-center gap-3 justify-end">
              <div className="flex items-center gap-2">
                <Switch id="live-mode" checked={isLiveMode} onCheckedChange={toggleLiveMode} />
                <Label htmlFor="live-mode" className="flex items-center gap-1.5 cursor-pointer">
                  {isLiveMode ? <Play className="w-4 h-4 text-green-500" /> : <Pause className="w-4 h-4 text-muted-foreground" />}
                  Live
                </Label>
              </div>
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading} className="gap-2">
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={() => clearOldLogsMutation.mutate()} disabled={clearOldLogsMutation.isPending} className="gap-2">
                <Trash2 className="w-4 h-4" />
                Clear Old
              </Button>
              {hasActiveFilters && (
                <Button variant="outline" size="sm" onClick={() => setShowDeleteFilteredDialog(true)} disabled={deleteFilteredMutation.isPending} className="gap-2 text-destructive border-destructive/30 hover:bg-destructive/10">
                  <Trash2 className="w-4 h-4" />
                  Delete Filtered
                </Button>
              )}
            </div>

            {/* Bulk Selection Bar */}
            {selectedLogIds.size > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <Checkbox
                  checked={selectedLogIds.size === logs.length}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="text-sm font-medium">{selectedLogIds.size} selected</span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-2"
                  disabled={bulkDeleteMutation.isPending}
                  onClick={() => setShowBulkDeleteDialog(true)}
                >
                  {bulkDeleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Delete Selected
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedLogIds(new Set())}>
                  Deselect All
                </Button>
              </div>
            )}

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="text-2xl font-bold">{logs.length}</p>
                      <p className="text-xs text-muted-foreground">Total Logs</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-red-500" />
                    <div>
                      <p className="text-2xl font-bold text-red-500">{errorCount}</p>
                      <p className="text-xs text-muted-foreground">Errors</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-yellow-500" />
                    <div>
                      <p className="text-2xl font-bold text-yellow-500">{warnCount}</p>
                      <p className="text-xs text-muted-foreground">Warnings</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <Info className="w-5 h-5 text-blue-500" />
                    <div>
                      <p className="text-2xl font-bold text-blue-500">{infoCount}</p>
                      <p className="text-xs text-muted-foreground">Info</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Filters */}
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="flex-1">
                    <div className="relative">
                      <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input placeholder="Search logs..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="ps-10" />
                    </div>
                  </div>
                  <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                    <SelectTrigger className="w-[280px]">
                      <SelectValue placeholder="Filter by user" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <span className="flex items-center gap-2">
                          All Users
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{userLogCounts._total || 0}</Badge>
                        </span>
                      </SelectItem>
                      <SelectItem value="system">
                        <span className="flex items-center gap-2">
                          System (no user)
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{userLogCounts._system || 0}</Badge>
                        </span>
                      </SelectItem>
                      {Object.entries(profilesMap).map(([id, p]) => (
                        <SelectItem key={id} value={id}>
                          <span className="flex items-center gap-2">
                            {p.full_name ? `${p.full_name} (${p.email})` : p.email}
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{userLogCounts[id] || 0}</Badge>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      {LOG_CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          <span className="flex items-center gap-2">
                            <cat.icon className="w-4 h-4" />
                            {cat.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={selectedLevel} onValueChange={setSelectedLevel}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder="Level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Levels</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                      <SelectItem value="warn">Warning</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="debug">Debug</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* Logs Table */}
            <Card>
              <CardHeader className="pb-3">
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={logs.length > 0 && selectedLogIds.size === logs.length}
                      onCheckedChange={toggleSelectAll}
                      disabled={logs.length === 0}
                    />
                    <CardTitle>Log Entries</CardTitle>
                    <CardDescription>
                      {isLiveMode && (
                        <span className="flex items-center gap-1.5 text-green-500">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                          </span>
                          Live updates enabled
                        </span>
                      )}
                    </CardDescription>
                  </div>
                  <Badge variant="secondary">{logs.length} entries</Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[500px]">
                  {isLoading && logs.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                      <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : logs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Database className="w-12 h-12 mb-3 opacity-50" />
                      <p>No logs found</p>
                      <p className="text-sm">Logs will appear here as edge functions run</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {logs.map((log, index) => (
                        <div key={log.id} className={`p-4 hover:bg-muted/50 transition-colors ${selectedLogIds.has(log.id) ? "bg-primary/5" : ""}`}>
                          <div className="flex items-start gap-3">
                            <span className="text-xs text-muted-foreground font-mono mt-1 min-w-[2rem] text-end">{index + 1}</span>
                            <Checkbox
                              checked={selectedLogIds.has(log.id)}
                              onCheckedChange={() => toggleLogSelection(log.id)}
                              className="mt-0.5"
                            />
                            {getLevelIcon(log.level)}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <Badge variant={getLevelBadgeVariant(log.level)} className="text-xs">{log.level.toUpperCase()}</Badge>
                                <Badge variant="outline" className="text-xs">{log.category}</Badge>
                                <Badge variant="secondary" className="text-xs flex items-center gap-1">
                                  <User className="w-3 h-3" />
                                  {log.userEmail || "System"}
                                </Badge>
                                <span className="text-xs text-muted-foreground font-mono">{log.source}</span>
                              </div>
                              <p className="text-sm break-all">{log.message}</p>
                              {log.metadata && Object.keys(log.metadata).length > 0 && renderMetadataDetails(log.metadata)}
                              
                              {analysisResults.has(log.id) && (
                                <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-sm font-semibold">
                                      <Sparkles className="w-4 h-4 text-primary" />
                                      AI Analysis
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                                      disabled={deleteAnalysisMutation.isPending}
                                      onClick={() => deleteAnalysisMutation.mutate(log.id)}
                                    >
                                      {deleteAnalysisMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                      Delete
                                    </Button>
                                  </div>
                                  <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3">
                                    <div className="flex items-center gap-2 mb-1">
                                      <Lightbulb className="w-4 h-4 text-blue-500" />
                                      <span className="text-xs font-semibold text-blue-500">What Happened</span>
                                    </div>
                                    <p className="text-sm">{analysisResults.get(log.id)!.explanation}</p>
                                  </div>
                                  <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3">
                                    <div className="flex items-center gap-2 mb-1">
                                      <Target className="w-4 h-4 text-yellow-500" />
                                      <span className="text-xs font-semibold text-yellow-500">Root Cause</span>
                                    </div>
                                    <p className="text-sm">{analysisResults.get(log.id)!.root_cause}</p>
                                  </div>
                                  <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
                                    <div className="flex items-center justify-between mb-2">
                                      <div className="flex items-center gap-2">
                                        <MessageSquare className="w-4 h-4 text-primary" />
                                        <span className="text-xs font-semibold text-primary">Lovable Prompt</span>
                                      </div>
                                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => handleCopyPrompt(log.id, analysisResults.get(log.id)!.lovable_prompt)}>
                                        {copiedPromptId === log.id ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy Prompt</>}
                                      </Button>
                                    </div>
                                    <pre className="text-xs bg-background rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap font-mono border">
                                      {analysisResults.get(log.id)!.lovable_prompt}
                                    </pre>
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground whitespace-nowrap">
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 mb-1" disabled={analyzingLogId === log.id} onClick={() => handleAnalyzeLog(log)}>
                                {analyzingLogId === log.id ? (
                                  <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing...</>
                                ) : analysisResults.has(log.id) ? (
                                  <><Sparkles className="w-3 h-3 text-primary" /> Re-analyze</>
                                ) : (
                                  <><Sparkles className="w-3 h-3" /> Analyze</>
                                )}
                              </Button>
                              <div className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                              </div>
                              <div className="text-[10px]">
                                {format(new Date(log.created_at), "MMM d, HH:mm:ss")}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Cron Operations Tab */}
          <TabsContent value="cron">
            <CronOperationsTab />
          </TabsContent>
        </Tabs>

        {/* Bulk Delete Confirmation */}
        <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {selectedLogIds.size} Log(s)</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete {selectedLogIds.size} selected log entries? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={bulkDeleteMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  bulkDeleteMutation.mutate([...selectedLogIds]);
                  setShowBulkDeleteDialog(false);
                }}
                disabled={bulkDeleteMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {bulkDeleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete Filtered Confirmation */}
        <AlertDialog open={showDeleteFilteredDialog} onOpenChange={setShowDeleteFilteredDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete All Filtered Logs</AlertDialogTitle>
              <AlertDialogDescription>
                This will delete <strong>all</strong> logs matching your current filters (not just the visible {logs.length}). This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteFilteredMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  deleteFilteredMutation.mutate();
                  setShowDeleteFilteredDialog(false);
                }}
                disabled={deleteFilteredMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteFilteredMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
                Delete All Filtered
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AdminLayout>
  );
}
