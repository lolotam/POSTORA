import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Loader2, AtSign, BarChart3, Eye, Heart, MessageCircle,
  Repeat2, Quote, Share2, Users, Shield, ExternalLink, ArrowUpDown,
  TrendingUp, Activity, CalendarDays, Info, Crown, ArrowUp, ArrowDown, Minus, FileText, Copy
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface InsightMetric {
  title: string;
  description: string;
  value: number;
  previous?: number;
  daily?: number[];
  period: string;
}

interface PostWithMetrics {
  id: string;
  text: string;
  timestamp: string;
  media_type: string;
  media_url: string;
  permalink: string;
  thumbnail_url: string;
  metrics: {
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    shares: number;
  };
}

interface AggregatedStats {
  avg_views_per_post: number;
  avg_engagement_per_post: number;
  total_posts: number;
  posting_frequency: string;
}

interface ActivityStats {
  current_posts: number;
  previous_posts: number;
  daily_posts: number[];
}

const METRIC_ICONS: Record<string, any> = {
  views: Eye,
  likes: Heart,
  replies: MessageCircle,
  reposts: Repeat2,
  quotes: Quote,
  shares: Share2,
  followers_count: Users,
};

function metricLabel(key: string, fallback: string, t: (key: string, defaultValue: string) => string): string {
  if (key === "views") return t("insights.views", "Views");
  if (key === "likes") return t("insights.likes", "Likes");
  if (key === "replies") return t("insights.comments", "Comments");
  if (key === "reposts") return t("insights.reposts", "Reposts");
  if (key === "quotes") return t("insights.quotes", "Quotes");
  if (key === "shares") return t("insights.shares", "Shares");
  if (key === "followers_count") return t("insights.followers", "Followers");
  return fallback;
}

type SortKey = "views" | "likes" | "replies" | "reposts" | "quotes" | "shares" | "engagement" | "timestamp";
type PeriodDays = 7 | 14 | 30 | 90;

interface ThreadsAccount {
  id: string;
  platform_username: string;
  avatar_url: string | null;
}

const formatValue = (val: number) => {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toLocaleString();
};

// Inline SVG sparkline
function Sparkline({ data, className }: { data: number[]; className?: string }) {
  if (!data || data.length === 0) {
    return <div className={cn("h-8 w-20", className)} />;
  }
  const w = 80;
  const h = 32;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `M0,${h} L${points.replace(/ /g, " L")} L${w},${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("h-8 w-20", className)} preserveAspectRatio="none">
      <path d={areaPath} fill="hsl(var(--primary) / 0.15)" />
      <polyline
        points={points}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Insight card with delta + sparkline
function InsightCard({
  icon: Icon,
  label,
  value,
  previous,
  daily,
}: {
  icon: any;
  label: string;
  value: number;
  previous: number;
  daily: number[];
}) {
  const { t } = useTranslation("analytics");
  const delta = value - previous;
  const isUp = delta > 0;
  const isDown = delta < 0;
  const ArrowIcon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
  const deltaColor = isUp
    ? "text-emerald-600 dark:text-emerald-400"
    : isDown
    ? "text-rose-600 dark:text-rose-400"
    : "text-muted-foreground";

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className="w-3.5 h-3.5" />
            <span className="font-medium">{label}</span>
          </div>
        </div>
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-2xl font-bold leading-none">{formatValue(value)}</p>
            <div className={cn("flex items-center gap-1 text-xs mt-1.5", deltaColor)}>
              <ArrowIcon className="w-3 h-3" />
              <span>{t("insights.previous", "Previous: {{value}}", { value: formatValue(previous) })}</span>
            </div>
          </div>
          <Sparkline data={daily} className="shrink-0" />
        </div>
      </CardContent>
    </Card>
  );
}

export function ThreadsInsightsPanel() {
  const { t } = useTranslation("analytics");
  const [isLoading, setIsLoading] = useState(true);
  const [insights, setInsights] = useState<Record<string, InsightMetric> | null>(null);
  const [posts, setPosts] = useState<PostWithMetrics[]>([]);
  const [aggregated, setAggregated] = useState<AggregatedStats | null>(null);
  const [activity, setActivity] = useState<ActivityStats | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("views");
  const [sortAsc, setSortAsc] = useState(false);
  const [accounts, setAccounts] = useState<ThreadsAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState<PeriodDays>(7);

  // Load all connected Threads accounts once for the picker.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("social_accounts")
        .select("id, platform_username, avatar_url")
        .eq("user_id", user.id)
        .eq("platform", "threads")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      if (data) setAccounts(data as ThreadsAccount[]);
    })();
  }, []);

  const fetchInsights = async (accountId?: string | null, period: PeriodDays = periodDays) => {
    setIsLoading(true);
    setError(null);
    setNeedsConnection(false);
    setNeedsPermission(false);
    setInsights(null);
    setPosts([]);
    setAggregated(null);
    setActivity(null);
    setUsername(null);

    try {
      const body: Record<string, unknown> = { periodDays: period };
      if (accountId) body.accountId = accountId;
      const { data, error: fnError } = await supabase.functions.invoke("threads-insights", { body });

      let resBody: any = data;
      if (fnError && !data) {
        try {
          if (fnError.context && typeof fnError.context.json === "function") {
            resBody = await fnError.context.json();
          }
        } catch { /* ignore */ }
        if (!resBody) { setError(fnError.message || t("errors.unknown", "Unknown error")); return; }
      }

      if (resBody && resBody.ok === false) {
        const reason = resBody.reason;
        const selectionError = new Map([
          ["account_not_found", t("errors.insightsAccountNotFound", "The selected Threads account is unavailable.")],
          ["storage_error", t("errors.insightsStorageFailed", "Unable to load the Threads account. Please retry.")],
          ["invalid_request", t("errors.insightsInvalidRequest", "Invalid Threads insights request. Refresh the page and retry.")],
          ["unauthorized", t("errors.insightsUnauthorized", "Your session could not be verified. Please sign in again.")],
          ["wrong_account", t("errors.insightsReconnect", "Reconnect the selected Threads account.")],
          ["invalid_token", t("errors.insightsReconnect", "Reconnect the selected Threads account.")],
          ["expired_token", t("errors.insightsReconnect", "Reconnect the selected Threads account.")],
          ["rate_limited", t("errors.insightsRateLimited", "Threads request limit reached. Please retry later.")],
          ["not_eligible", t("errors.insightsNotEligible", "The selected Threads account is not eligible for these insights.")],
          ["not_found", t("errors.insightsNotFound", "Threads could not find the requested account or content.")],
          ["transient", t("errors.insightsFailed", "Threads insights failed.")],
          ["unknown", t("errors.insightsFailed", "Threads insights failed.")],
        ]).get(reason);
        if (selectionError) {
          setError(selectionError);
          return;
        }
        if (reason === "no_account") {
          setNeedsConnection(true);
          setError(resBody.message || t("errors.noThreads", "No Threads account connected."));
          return;
        }
        if (reason === "permission_not_approved" || reason === "missing_scope") {
          setNeedsPermission(true);
          setError(t("errors.insightsPermission", "Threads insights permission not granted."));
          return;
        }
        setError(resBody.message || t("errors.insightsFailed", "Threads insights failed."));
        return;
      }

      if (resBody?.error && resBody.ok !== true) { setError(resBody.error); return; }

      setInsights(resBody.insights || {});
      setPosts(resBody.posts || []);
      setAggregated(resBody.aggregated || null);
      setActivity(resBody.activity || null);
      setUsername(resBody.username || null);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInsights(selectedAccountId, periodDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, periodDays]);

  const sortedPosts = useMemo(() => {
    if (!posts.length) return [];
    return [...posts].sort((a, b) => {
      let aVal: number, bVal: number;
      if (sortKey === "engagement") {
        aVal = a.metrics.likes + a.metrics.replies + a.metrics.reposts + a.metrics.quotes + (a.metrics.shares || 0);
        bVal = b.metrics.likes + b.metrics.replies + b.metrics.reposts + b.metrics.quotes + (b.metrics.shares || 0);
      } else if (sortKey === "timestamp") {
        aVal = new Date(a.timestamp).getTime();
        bVal = new Date(b.timestamp).getTime();
      } else {
        aVal = a.metrics[sortKey] || 0;
        bVal = b.metrics[sortKey] || 0;
      }
      return sortAsc ? aVal - bVal : bVal - aVal;
    });
  }, [posts, sortKey, sortAsc]);

  const topPostId = useMemo(() => {
    if (!posts.length) return null;
    let best = posts[0];
    let bestEng = 0;
    for (const p of posts) {
      const eng = p.metrics.likes + p.metrics.replies + p.metrics.reposts + p.metrics.quotes + (p.metrics.shares || 0);
      if (eng > bestEng) { bestEng = eng; best = p; }
    }
    return best.id;
  }, [posts]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const SortHeader = ({ label, sortKeyVal }: { label: string; sortKeyVal: SortKey }) => (
    <button
      onClick={() => handleSort(sortKeyVal)}
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
    >
      {label}
      <ArrowUpDown className={`w-3 h-3 ${sortKey === sortKeyVal ? "text-primary" : ""}`} />
    </button>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
        <p className="text-sm text-muted-foreground">{t("insights.loading", "Loading Threads Insights...")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
            <BarChart3 className="w-5 h-5 text-primary" />
            {t("insights.title", "Threads Insights")}
            {accounts.length > 0 && (
              <Select
                value={selectedAccountId ?? accounts.find(a => a.platform_username === username)?.id ?? ""}
                onValueChange={(val) => setSelectedAccountId(val)}
              >
                <SelectTrigger className="h-8 w-auto min-w-[200px] text-sm font-normal">
                  <SelectValue placeholder={t("ads.selectAccount", "Select account")} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      <div className="flex items-center gap-2">
                        <Avatar className="w-5 h-5">
                          <AvatarImage src={acc.avatar_url || undefined} />
                          <AvatarFallback className="text-[10px]">
                            {acc.platform_username?.[0]?.toUpperCase() || "?"}
                          </AvatarFallback>
                        </Avatar>
                        @{acc.platform_username}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("insights.subtitle", "Performance analytics for your Threads profile and posts")}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(periodDays)} onValueChange={(v) => setPeriodDays(Number(v) as PeriodDays)}>
            <SelectTrigger className="h-8 w-[140px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t("header.date7", "Last 7 days")}</SelectItem>
              <SelectItem value="14">{t("header.date14", "Last 14 days")}</SelectItem>
              <SelectItem value="30">{t("header.date30", "Last 30 days")}</SelectItem>
              <SelectItem value="90">{t("header.date90", "Last 90 days")}</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" className="gap-1 text-xs">
            <Shield className="w-3 h-3" />
            {t("insights.yourAccountOnly", "Your Account Only")}
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => fetchInsights(selectedAccountId, periodDays)} disabled={isLoading} className="gap-1">
            <Loader2 className={`w-3 h-3 ${isLoading ? "animate-spin" : "hidden"}`} />
            {t("common:refresh", "Refresh")}
          </Button>
        </div>
      </div>


      {/* Connection needed */}
      {needsConnection && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-6 text-center space-y-3">
            <AtSign className="w-10 h-10 mx-auto text-amber-500" />
            <h3 className="font-semibold">{t("threads.connectAccount", "Connect Your Threads Account")}</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {t("threads.connectInsights", "To view Threads Insights, connect your Threads account with the required permissions.")}
            </p>
            <Button variant="outline" className="gap-2" onClick={() => window.location.href = "/profiles"}>
              <AtSign className="w-4 h-4" />
              {t("actions.goToProfiles", "Go to Profiles")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Permission / Error warning */}
      {error && !needsConnection && (
        <div className={`p-4 rounded-lg text-sm ${
          needsPermission || error.includes("Meta has not approved")
            ? "border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : "bg-destructive/10 text-destructive"
        }`}>
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* === Profile Metrics with comparisons + sparklines === */}
      {insights && Object.keys(insights).length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            {t("insights.profileMetrics", "Profile Metrics · Last {{days}} days", { days: periodDays })}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {/* Your activity card */}
            {activity && (
              <InsightCard
                icon={FileText}
                label={t("insights.yourActivity", "Your activity")}
                value={activity.current_posts}
                previous={activity.previous_posts}
                daily={activity.daily_posts}
              />
            )}
            {Object.entries(insights).map(([key, metric]) => {
              const IconComp = METRIC_ICONS[key] || BarChart3;
              return (
                <InsightCard
                  key={key}
                  icon={IconComp}
                  label={metricLabel(key, metric.title || key, t)}
                  value={metric.value}
                  previous={metric.previous ?? 0}
                  daily={metric.daily ?? []}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* === Aggregated Analytics === */}
      {aggregated && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{t("insights.aggregated", "Aggregated Analytics")}</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4 text-center">
                <Eye className="w-5 h-5 mx-auto mb-1 text-primary" />
                <p className="text-xl font-bold">{formatValue(aggregated.avg_views_per_post)}</p>
                <p className="text-xs text-muted-foreground">{t("insights.avgViews", "Avg Views / Post")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <TrendingUp className="w-5 h-5 mx-auto mb-1 text-primary" />
                <p className="text-xl font-bold">{formatValue(aggregated.avg_engagement_per_post)}</p>
                <p className="text-xs text-muted-foreground">{t("insights.avgEngagement", "Avg Engagement / Post")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <Activity className="w-5 h-5 mx-auto mb-1 text-primary" />
                <p className="text-xl font-bold">{aggregated.posting_frequency}</p>
                <p className="text-xs text-muted-foreground">{t("insights.postingFrequency", "Posting Frequency")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <CalendarDays className="w-5 h-5 mx-auto mb-1 text-primary" />
                <p className="text-xl font-bold">{aggregated.total_posts}</p>
                <p className="text-xs text-muted-foreground">{t("insights.postsAnalyzed", "Posts Analyzed")}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* === Recent Posts Performance === */}
      {sortedPosts.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{t("insights.recentPerformance", "Recent Posts Performance")}</h4>
          <div className="border rounded-lg overflow-hidden">
            <div className="grid grid-cols-[40px_1fr_repeat(7,_minmax(60px,80px))_64px] gap-2 px-4 py-2 bg-muted/50 text-xs font-medium border-b items-center">
              <span className="text-center text-muted-foreground">#</span>
              <SortHeader label={t("insights.post", "Post")} sortKeyVal="timestamp" />
              <SortHeader label={t("insights.views", "Views")} sortKeyVal="views" />
              <SortHeader label={t("insights.likes", "Likes")} sortKeyVal="likes" />
              <SortHeader label={t("insights.comments", "Comments")} sortKeyVal="replies" />
              <SortHeader label={t("insights.reposts", "Reposts")} sortKeyVal="reposts" />
              <SortHeader label={t("insights.quotes", "Quotes")} sortKeyVal="quotes" />
              <SortHeader label={t("insights.shares", "Shares")} sortKeyVal="shares" />
              <SortHeader label={t("insights.engagement", "Engagement")} sortKeyVal="engagement" />
              <span />
            </div>
            {sortedPosts.map((post, index) => {
              const engagement = post.metrics.likes + post.metrics.replies + post.metrics.reposts + post.metrics.quotes + (post.metrics.shares || 0);
              const isTop = post.id === topPostId;
              const hasText = !!(post.text && post.text.trim());
              const handleCopy = async () => {
                if (!hasText) return;
                try {
                  await navigator.clipboard.writeText(post.text);
                  toast.success(t("toast.postCopied", "Post copied"));
                } catch {
                  toast.error(t("errors.copyFailed", "Failed to copy"));
                }
              };
              return (
                <div
                  key={post.id}
                  className={`grid grid-cols-[40px_1fr_repeat(7,_minmax(60px,80px))_64px] gap-2 px-4 py-3 border-b last:border-b-0 items-center text-sm hover:bg-muted/30 transition-colors ${isTop ? "bg-primary/5" : ""}`}
                >
                  <span className="text-xs text-center text-muted-foreground tabular-nums">{index + 1}</span>
                  <div className="flex items-center gap-2 min-w-0">
                    {isTop && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                    <span className="truncate text-xs">{post.text || "—"}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 hidden md:inline">
                      {new Date(post.timestamp).toLocaleDateString()}
                    </span>
                  </div>
                  <span className="text-xs text-center tabular-nums">{formatValue(post.metrics.views)}</span>
                  <span className="text-xs text-center tabular-nums">{formatValue(post.metrics.likes)}</span>
                  <span className="text-xs text-center tabular-nums">{formatValue(post.metrics.replies)}</span>
                  <span className="text-xs text-center tabular-nums">{formatValue(post.metrics.reposts)}</span>
                  <span className="text-xs text-center tabular-nums">{formatValue(post.metrics.quotes)}</span>
                  <span className="text-xs text-center tabular-nums">{formatValue(post.metrics.shares || 0)}</span>
                  <span className="text-xs text-center tabular-nums font-medium">{formatValue(engagement)}</span>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={handleCopy}
                      disabled={!hasText}
                      title={hasText ? t("insights.copyPost", "Copy post") : t("insights.noTextToCopy", "No text to copy")}
                      className="text-muted-foreground hover:text-primary disabled:opacity-40 disabled:hover:text-muted-foreground transition-colors"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={post.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t("insights.viewOnThreads", "View on Threads")}
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
