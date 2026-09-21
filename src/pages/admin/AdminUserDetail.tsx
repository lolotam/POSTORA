import { useState, useMemo, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { allPlatforms } from "@/lib/platformConstants";
import { isTokenExpired, formatTokenExpiry } from "@/lib/tokenUtils";
import { TokenLifetimeInfo, ReconnectionFrequencyBadge } from "@/components/profiles/TokenLifetimeInfo";
import { supabase } from "@/integrations/supabase/client";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "@/lib/subscriptionStatus";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft, Image, HardDrive, Send, Link2, Loader2,
  Calendar, FileText, ImagePlus, Globe, Search, AlertTriangle,
  ShieldAlert, ShieldCheck, ClipboardCopy,
  AlertCircle, Info, CheckCircle, Bug, ExternalLink, Clock,
  Sparkles, Copy, Check, Target, Lightbulb, MessageSquare,
  Cpu, DollarSign, Hash,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  PostFilters,
  HistoryTable,
  PostDetailsDialog,
} from "@/components/history";
import type { PlatformPost } from "@/hooks/usePosts";
import { formatQuotaValue } from "./AdminUsers";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

interface AccountInfo {
  username: string | null;
  avatarUrl: string | null;
  profileName: string | null;
  tiktokUsername?: string | null;
}

interface PostWithResults {
  id: string;
  caption: string | null;
  platforms: string[];
  status: string | null;
  created_at: string;
  source?: string;
  media_file_ids?: string[] | null;
  platformResults: PlatformPost[];
}

export default function AdminUserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  // History-style filter state
  const [search, setSearch] = useState("");
  const [selectedFilter, setSelectedFilter] = useState<"all" | "completed" | "failed" | "pending">("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "api">("all");
  const [platformFilter, setPlatformFilter] = useState<Platform | "all">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [selectedPosts, setSelectedPosts] = useState<Set<string>>(new Set());
  const [detailsPost, setDetailsPost] = useState<PostWithResults | null>(null);
  const [detailsMedia, setDetailsMedia] = useState<Array<{ id: string; url: string; kind: "image" | "video" }>>([]);
  const [detailsMediaLoading, setDetailsMediaLoading] = useState(false);
  const [accountsCache, setAccountsCache] = useState<Record<string, AccountInfo>>({});

  // Logs tab state
  const [logLevelFilter, setLogLevelFilter] = useState("all");
  const [logCategoryFilter, setLogCategoryFilter] = useState("all");
  const [logPage, setLogPage] = useState(1);
  const logsPerPage = 20;

  // Fetch profile
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ["admin-user-profile", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
  });

  // Fetch role
  const { data: userRole } = useQuery({
    queryKey: ["admin-user-role", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId!)
        .single();
      if (error) return { role: "user" };
      return data;
    },
    enabled: !!userId,
  });

  // Fetch subscription + plan
  //
  // F5 (CodeRabbit round 1, 2026-08-23): this used to filter
  // `.in("status", ["active", "trialing"])`, which never included
  // "past_due" - a dunning user showed as paid in AdminUsers.tsx's list
  // (already fixed) but Free here. "trialing" was dead: subscriptionStatus.ts
  // (stripe-webhook) maps it to "active" before it ever reaches this column.
  // Use the single shared entitlement predicate instead. The ORDER BY +
  // LIMIT(1) mirrors useSubscription.tsx's own fix for the same widening:
  // an IN(...) with no uniqueness constraint on active subscriptions can
  // return 2+ rows, and .maybeSingle() throws on that.
  const { data: subscription } = useQuery({
    queryKey: ["admin-user-subscription", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_subscriptions")
        .select(`*, subscription_plans:plan_id (slug, name)`)
        .eq("user_id", userId!)
        .in("status", ENTITLED_SUBSCRIPTION_STATUSES)
        .order("current_period_end", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
  });

  // Fetch social accounts (full data for accountsCache)
  const { data: socialAccounts = [] } = useQuery({
    queryKey: ["admin-user-social-accounts", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("social_accounts")
        .select(`
          id, platform, platform_username, platform_user_id, avatar_url, is_active, connected_at,
          account_metadata, token_expires_at, needs_reauth, last_refresh_error,
          social_profile_id,
          social_profiles!social_accounts_social_profile_id_fkey (name)
        `)
        .eq("user_id", userId!);
      if (error) throw error;
      return data || [];
    },
    enabled: !!userId,
  });

  // Fetch media files for stats
  const { data: mediaFiles = [] } = useQuery({
    queryKey: ["admin-user-media", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("media_files")
        .select("file_type, file_size, mime_type")
        .eq("user_id", userId!);
      if (error) throw error;
      return data || [];
    },
    enabled: !!userId,
  });

  // Fetch posts with full data
  const { data: posts = [], isLoading: postsLoading } = useQuery({
    queryKey: ["admin-user-posts", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("posts")
        .select("id, caption, platforms, status, source, scheduled_at, posted_at, created_at, media_file_ids, metadata")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!userId,
  });

  // Fetch platform posts
  const { data: platformPosts = [] } = useQuery({
    queryKey: ["admin-user-platform-posts", userId, posts.length],
    queryFn: async () => {
      if (!posts.length) return [];
      const postIds = posts.map((p) => p.id);
      const { data, error } = await supabase
        .from("platform_posts")
        .select("*")
        .in("post_id", postIds)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: posts.length > 0,
  });

  // Fetch quotas
  const { data: quotas } = useQuery({
    queryKey: ["admin-user-quotas", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_quotas")
        .select("*")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
  });

  // Fetch system logs for this user
  const { data: userLogs = [], isLoading: logsLoading } = useQuery({
    queryKey: ["admin-user-logs", userId, logLevelFilter, logCategoryFilter, logPage],
    queryFn: async () => {
      let query = supabase
        .from("system_logs")
        .select("*")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (logLevelFilter !== "all") query = query.eq("level", logLevelFilter);
      if (logCategoryFilter !== "all") query = query.eq("category", logCategoryFilter);
      const from = (logPage - 1) * logsPerPage;
      const to = from + logsPerPage - 1;
      query = query.range(from, to);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!userId,
  });

  // Fetch AI usage stats for this user
  const { data: aiUsageStats } = useQuery({
    queryKey: ["admin-user-ai-usage", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("api_logs")
        .select("endpoint, created_at")
        .eq("user_id", userId!)
        .in("endpoint", ["generate-caption", "generate-hashtags", "generate-image"]);
      if (error) throw error;

      const stats = { captions: 0, hashtags: 0, images: 0, total: 0 };
      (data || []).forEach((log: any) => {
        if (log.endpoint === "generate-caption") stats.captions++;
        else if (log.endpoint === "generate-hashtags") stats.hashtags++;
        else if (log.endpoint === "generate-image") stats.images++;
        stats.total++;
      });

      // Estimate tokens: ~500 per caption, ~300 per hashtag, ~100 per image prompt
      const estimatedTokens = (stats.captions * 500) + (stats.hashtags * 300) + (stats.images * 100);
      return { ...stats, estimatedTokens };
    },
    enabled: !!userId,
  });

  // Fetch model pricing for cost estimation
  const { data: modelPricing } = useQuery({
    queryKey: ["ai-model-avg-pricing"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_models")
        .select("cost_per_1m_input_tokens, cost_per_1m_output_tokens")
        .eq("is_active", true);
      if (error) throw error;
      // Calculate average cost across all active models
      const models = (data || []).filter((m: any) => (Number(m.cost_per_1m_input_tokens) || 0) > 0);
      if (models.length === 0) return { avgCostPerK: 0.001 };
      const totalAvg = models.reduce((sum: number, m: any) => {
        return sum + ((Number(m.cost_per_1m_input_tokens) || 0) + (Number(m.cost_per_1m_output_tokens) || 0)) / 2;
      }, 0) / models.length;
      return { avgCostPerK: totalAvg / 1000 }; // per 1K tokens
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch total log count for pagination
  const { data: logCount = 0 } = useQuery({
    queryKey: ["admin-user-logs-count", userId, logLevelFilter, logCategoryFilter],
    queryFn: async () => {
      let query = supabase
        .from("system_logs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId!);
      if (logLevelFilter !== "all") query = query.eq("level", logLevelFilter);
      if (logCategoryFilter !== "all") query = query.eq("category", logCategoryFilter);
      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    },
    enabled: !!userId,
  });

  // Fetch persisted log analyses
  const userLogIds = userLogs.map((l: any) => l.id);
  const { data: userAnalysesData = [] } = useQuery({
    queryKey: ["admin-user-log-analyses", userLogIds],
    queryFn: async () => {
      if (userLogIds.length === 0) return [];
      const { data, error } = await supabase
        .from("log_analyses" as any)
        .select("*")
        .in("log_id", userLogIds);
      if (error) throw error;
      return data || [];
    },
    enabled: userLogIds.length > 0,
  });

  const queryClient = useQueryClient();
  const [analyzingLogId, setAnalyzingLogId] = useState<string | null>(null);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);

  const userAnalysisResults = useMemo(() => {
    const map = new Map<string, { explanation: string; root_cause: string; lovable_prompt: string }>();
    for (const a of userAnalysesData as any[]) {
      map.set(a.log_id, { explanation: a.explanation, root_cause: a.root_cause, lovable_prompt: a.lovable_prompt });
    }
    return map;
  }, [userAnalysesData]);

  const handleAnalyzeUserLog = useCallback(async (log: any) => {
    setAnalyzingLogId(log.id);
    try {
      const { data, error } = await supabase.functions.invoke('analyze-log', { body: { log } });
      if (error) throw error;
      if (data?.error) { toast.error('Analysis failed', { description: data.error }); return; }
      queryClient.invalidateQueries({ queryKey: ["admin-user-log-analyses"] });
      toast.success('Log analyzed successfully');
    } catch (err: unknown) {
      toast.error('Failed to analyze log', { description: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setAnalyzingLogId(null);
    }
  }, [queryClient]);

  const handleCopyUserPrompt = useCallback(async (logId: string, prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPromptId(logId);
      toast.success('Prompt copied');
      setTimeout(() => setCopiedPromptId(null), 2000);
    } catch { toast.error('Failed to copy'); }
  }, []);

  // Build accountsCache from social accounts
  useEffect(() => {
    if (socialAccounts.length === 0) return;
    const cache: Record<string, AccountInfo> = {};
    socialAccounts.forEach((acc: any) => {
      let tiktokUsername: string | null = null;
      if (acc.platform === "tiktok" && acc.account_metadata) {
        tiktokUsername =
          acc.account_metadata.tiktok_username ||
          acc.account_metadata.creator_username ||
          null;
      }
      cache[acc.id] = {
        username: acc.platform_username ?? null,
        avatarUrl: acc.avatar_url ?? null,
        profileName: acc.social_profiles?.name ?? null,
        tiktokUsername,
      };
    });
    setAccountsCache(cache);
  }, [socialAccounts]);

  // Build posts with results (same shape as History.tsx)
  const postsWithResults: PostWithResults[] = useMemo(() => {
    return posts.map((post) => ({
      ...post,
      platformResults: (platformPosts || []).filter((pp) => pp.post_id === post.id) as PlatformPost[],
    }));
  }, [posts, platformPosts]);

  // Load media for details dialog
  useEffect(() => {
    let cancelled = false;
    async function loadDetailsMedia() {
      if (!detailsPost) {
        setDetailsMedia([]);
        return;
      }
      const mediaIds = (detailsPost.media_file_ids || []).filter((id) => typeof id === "string");
      if (mediaIds.length === 0) {
        setDetailsMedia([]);
        return;
      }
      setDetailsMediaLoading(true);
      const { data: mediaRows } = await supabase
        .from("media_files")
        .select("id, file_path, file_type, mime_type, storage_bucket")
        .in("id", mediaIds);
      if (cancelled) return;
      const previews: Array<{ id: string; url: string; kind: "image" | "video" }> = [];
      for (const m of mediaRows || []) {
        if (!m.file_path) continue;
        let url: string;
        if (m.storage_bucket === "cloudinary") {
          url = m.file_path;
        } else if (m.storage_bucket) {
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from(m.storage_bucket)
            .createSignedUrl(m.file_path, 3600);
          if (signedUrlError || !signedUrlData?.signedUrl) continue;
          url = signedUrlData.signedUrl;
        } else {
          continue;
        }
        const mime = (m.mime_type || "").toLowerCase();
        const kind: "image" | "video" = mime.startsWith("video/") || m.file_type === "video" ? "video" : "image";
        previews.push({ id: m.id, url, kind });
      }
      if (!cancelled) {
        setDetailsMedia(previews);
        setDetailsMediaLoading(false);
      }
    }
    loadDetailsMedia();
    return () => { cancelled = true; };
  }, [detailsPost?.id]);

  // Computed media stats
  const mediaStats = useMemo(() => {
    const images = mediaFiles.filter((f) => f.file_type === "image").length;
    const videos = mediaFiles.filter((f) => f.file_type === "video").length;
    const gifs = mediaFiles.filter((f) => f.mime_type === "image/gif").length;
    const totalSize = mediaFiles.reduce((acc, f) => acc + (f.file_size || 0), 0);
    return { images, videos, gifs, total: mediaFiles.length, totalSize };
  }, [mediaFiles]);

  // Computed post stats
  const postStats = useMemo(() => {
    const manual = posts.filter((p) => !p.source || p.source === "manual").length;
    const api = posts.filter((p) => p.source === "api" || p.source === "n8n-api").length;
    return { total: posts.length, manual, api };
  }, [posts]);

  // Group accounts by platform
  const accountsByPlatform = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    allPlatforms.forEach((p) => {
      grouped[p.platform] = [];
    });
    socialAccounts.forEach((acc: any) => {
      if (grouped[acc.platform]) {
        grouped[acc.platform].push(acc);
      }
    });
    return grouped;
  }, [socialAccounts]);

  const defaultPlatformTab = useMemo(() => {
    const first = allPlatforms.find((p) => (accountsByPlatform[p.platform]?.length || 0) > 0);
    return first?.platform || "facebook";
  }, [accountsByPlatform]);

  // Filtering (same logic as History.tsx)
  const filteredPosts = useMemo(() => {
    return postsWithResults.filter((post) => {
      const matchesSearch = (post.caption || "").toLowerCase().includes(search.toLowerCase());
      const matchesStatus = selectedFilter === "all" || post.status === selectedFilter;
      const postSource = post.source || "manual";
      const isApi = postSource === "api" || postSource === "n8n-api";
      const matchesSource =
        sourceFilter === "all" ||
        (sourceFilter === "api" && isApi) ||
        (sourceFilter === "manual" && !isApi);
      const matchesPlatform = platformFilter === "all" || post.platforms.includes(platformFilter);
      return matchesSearch && matchesStatus && matchesSource && matchesPlatform;
    });
  }, [postsWithResults, search, selectedFilter, sourceFilter, platformFilter]);

  // Pagination
  const totalItems = filteredPosts.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedPosts = filteredPosts.slice(startIndex, endIndex);

  const handleFilterChange = (filterFn: () => void) => {
    filterFn();
    setCurrentPage(1);
  };

  // Selection helpers
  const togglePostSelection = (postId: string) => {
    setSelectedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  };

  const selectAllPosts = () => {
    setSelectedPosts(new Set(paginatedPosts.map((p) => p.id)));
  };

  const deselectAllPosts = () => {
    setSelectedPosts(new Set());
  };

  // No-op handlers for admin view (read-only)
  const noop = () => {};
  const noopPost = (_post: any) => {};
  const isTikTokMediaError = (_post: any) => false;

  const role = (userRole?.role as string) || "user";
  const planName = (subscription as any)?.subscription_plans?.name || (role === "admin" ? "Admin" : "Free");
  const planSlug = (subscription as any)?.subscription_plans?.slug || (role === "admin" ? "admin" : "free");

  if (profileLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  if (!profile) {
    return (
      <AdminLayout>
        <div className="text-center py-24 text-muted-foreground">
          <p>User not found.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/admin/users")}>
            <ArrowLeft className="w-4 h-4 me-2" /> Back to Users
          </Button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Back button */}
        <Button variant="ghost" size="sm" onClick={() => navigate("/admin/users")} className="gap-2">
          <ArrowLeft className="w-4 h-4" /> Back to Users
        </Button>

        {/* Header */}
        <div className="flex items-center gap-4">
          <Avatar className="w-16 h-16">
            <AvatarImage src={profile.avatar_url || undefined} />
            <AvatarFallback className="text-xl">
              {profile.full_name?.charAt(0) || profile.email?.charAt(0) || "U"}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <h2 className="text-2xl font-bold">{profile.full_name || "No Name"}</h2>
            <p className="text-muted-foreground">{profile.email}</p>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={role === "admin" ? "default" : role === "subscriber" ? "secondary" : "outline"}>
                {role}
              </Badge>
              <Badge variant="outline" className={
                planSlug === "business" ? "bg-purple-500/10 text-purple-600 border-purple-500/30" :
                planSlug === "pro" ? "bg-blue-500/10 text-blue-600 border-blue-500/30" :
                ""
              }>
                {planName}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Joined {format(new Date(profile.created_at), "MMM d, yyyy")}
              </span>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <Card noAnimation>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Image className="w-4 h-4" /> Total Media
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{mediaStats.total}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {mediaStats.images} images · {mediaStats.videos} videos · {mediaStats.gifs} GIFs
              </p>
            </CardContent>
          </Card>
          <Card noAnimation>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <HardDrive className="w-4 h-4" /> Storage Used
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatBytes(mediaStats.totalSize)}</p>
              <p className="text-xs text-muted-foreground mt-1">Cloud storage (Cloudinary)</p>
            </CardContent>
          </Card>
          <Card noAnimation>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Send className="w-4 h-4" /> Total Posts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{postStats.total}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {postStats.manual} manual · {postStats.api} API
              </p>
            </CardContent>
          </Card>
          <Card noAnimation>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Link2 className="w-4 h-4" /> Connected Accounts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{socialAccounts.filter((a: any) => a.is_active).length}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {socialAccounts.length} total ({socialAccounts.filter((a: any) => !a.is_active).length} inactive)
              </p>
            </CardContent>
          </Card>
          <Card noAnimation>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Cpu className="w-4 h-4" /> AI Usage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{aiUsageStats?.total || 0}</p>
              <p className="text-xs text-muted-foreground mt-1">
                ~{(aiUsageStats?.estimatedTokens || 0).toLocaleString()} tokens
              </p>
            </CardContent>
          </Card>
        </div>

        {/* AI Usage Breakdown Card */}
        {(aiUsageStats?.total || 0) > 0 && (
          <Card noAnimation>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="w-4 h-4" /> Tokens Used & AI Calls
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="text-muted-foreground flex items-center gap-1"><Sparkles className="w-3 h-3" /> Captions</p>
                  <p className="font-medium text-lg">{aiUsageStats?.captions || 0}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground flex items-center gap-1"><Hash className="w-3 h-3" /> Hashtags</p>
                  <p className="font-medium text-lg">{aiUsageStats?.hashtags || 0}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground flex items-center gap-1"><ImagePlus className="w-3 h-3" /> Images</p>
                  <p className="font-medium text-lg">{aiUsageStats?.images || 0}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground flex items-center gap-1"><Cpu className="w-3 h-3" /> Est. Tokens</p>
                  <p className="font-medium text-lg">{(aiUsageStats?.estimatedTokens || 0).toLocaleString()}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground flex items-center gap-1"><DollarSign className="w-3 h-3" /> Est. Cost</p>
                  <p className="font-medium text-lg">
                    ${(((aiUsageStats?.estimatedTokens || 0) / 1000) * (modelPricing?.avgCostPerK || 0.001)).toFixed(4)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tabs */}
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="calls">Publishing History ({postStats.total})</TabsTrigger>
            <TabsTrigger value="logs">Logs ({logCount})</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* Quotas */}
            {role !== "admin" && quotas && (
              <Card noAnimation>
                <CardHeader>
                  <CardTitle className="text-base">Quotas & Usage</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div className="space-y-1">
                      <p className="text-muted-foreground flex items-center gap-1"><Globe className="w-3 h-3" /> Accounts</p>
                      <p className="font-medium">{socialAccounts.filter((a: any) => a.is_active).length} / {formatQuotaValue((quotas as any).max_social_accounts)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-muted-foreground flex items-center gap-1"><FileText className="w-3 h-3" /> Posts/Month</p>
                      <p className="font-medium">{(quotas as any).posts_this_month ?? 0} / {formatQuotaValue((quotas as any).max_posts_per_month)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-muted-foreground flex items-center gap-1"><Calendar className="w-3 h-3" /> Posts/Day</p>
                      <p className="font-medium">{(quotas as any).posts_today ?? 0} / {formatQuotaValue((quotas as any).max_posts_per_day)}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-muted-foreground flex items-center gap-1"><ImagePlus className="w-3 h-3" /> Uploads/Day</p>
                      <p className="font-medium">{(quotas as any).media_uploads_today ?? 0} / {formatQuotaValue((quotas as any).max_media_uploads_per_day)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Connected Accounts - Platform Tabs */}
            <Card noAnimation>
              <CardHeader>
                <CardTitle className="text-base">Connected Social Accounts</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue={defaultPlatformTab} className="w-full">
                  <TabsList className="flex flex-wrap h-auto gap-1 bg-muted/50 p-1">
                    {allPlatforms.map((p) => {
                      const count = accountsByPlatform[p.platform]?.length || 0;
                      return (
                        <TabsTrigger
                          key={p.platform}
                          value={p.platform}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 data-[state=active]:bg-background"
                        >
                          <PlatformIcon platform={p.platform} size="xs" />
                          <span className="hidden sm:inline">{p.name}</span>
                          <Badge
                            variant="secondary"
                            className="h-4 min-w-[16px] px-1 text-[9px] data-[state=active]:bg-foreground data-[state=active]:text-background"
                          >
                            {count}
                          </Badge>
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>

                  {allPlatforms.map((p) => {
                    const accounts = accountsByPlatform[p.platform] || [];
                    return (
                      <TabsContent key={p.platform} value={p.platform} className="mt-4">
                        {accounts.length === 0 ? (
                          <div className="text-center py-12 text-muted-foreground">
                            <PlatformIcon platform={p.platform} size="lg" />
                            <p className="mt-3 text-sm">No {p.name} accounts connected.</p>
                          </div>
                        ) : (
                          <div className="rounded-xl border bg-card overflow-hidden">
                            <Table>
                              <TableHeader>
                                <TableRow className="bg-muted/50">
                                  <TableHead className="w-[50px]">#</TableHead>
                                  <TableHead className="w-[180px]">Account Name</TableHead>
                                  <TableHead className={p.platform === "pinterest" ? "w-[180px]" : "w-[280px]"}>User ID</TableHead>
                                  {p.platform === "pinterest" && <TableHead className="w-[180px]">Board ID</TableHead>}
                                  <TableHead className="w-[120px]">Token Expires</TableHead>
                                  <TableHead className="w-[140px]">Token Lifetime</TableHead>
                                  <TableHead className="w-[120px]">Status</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {accounts.map((account: any, index: number) => {
                                  const expired = isTokenExpired(account.token_expires_at);
                                  const needsReauth = account.needs_reauth;
                                  const metadata = account.account_metadata as Record<string, unknown> | null;

                                  const getPinterestAccessLevel = (): "standard" | "trial" | "unknown" => {
                                    if (account.platform !== "pinterest") return "unknown";
                                    if (metadata?.has_write_access === true || metadata?.access_level === "standard") return "standard";
                                    if (metadata?.has_write_access === false || metadata?.access_level === "trial") return "trial";
                                    return "unknown";
                                  };

                                  return (
                                    <TableRow key={account.id}>
                                      <TableCell className="text-muted-foreground font-mono text-sm">{index + 1}</TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-2">
                                          {account.avatar_url && (
                                            <Avatar className="w-5 h-5">
                                              <AvatarImage src={account.avatar_url} alt={account.platform_username || ""} />
                                              <AvatarFallback className="text-[8px]">
                                                <PlatformIcon platform={account.platform} size="xs" />
                                              </AvatarFallback>
                                            </Avatar>
                                          )}
                                          <span className="text-sm font-medium">{account.platform_username || "Unknown"}</span>
                                          {account.platform === "instagram" && (() => {
                                            const isBusinessLogin = account.ig_auth_type === "business_login" || metadata?.token_type === "long_lived";
                                            return isBusinessLogin ? (
                                              <Badge variant="secondary" className="h-4 text-[9px] px-1 bg-green-500/10 text-green-600 border-green-500/30">Direct</Badge>
                                            ) : (
                                              <Badge variant="secondary" className="h-4 text-[9px] px-1 bg-blue-500/10 text-blue-600 border-blue-500/30">via FB</Badge>
                                            );
                                          })()}
                                        </div>
                                      </TableCell>
                                      <TableCell>
                                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                                          {account.platform_user_id}
                                        </code>
                                      </TableCell>
                                      {p.platform === "pinterest" && (
                                        <TableCell>
                                          <span className="text-xs text-muted-foreground">—</span>
                                        </TableCell>
                                      )}
                                      <TableCell>
                                        <div className={`flex items-center gap-1.5 text-xs ${needsReauth ? "text-destructive font-bold" : expired ? "text-destructive" : "text-muted-foreground"}`}>
                                          {(expired || needsReauth) && <AlertTriangle className="w-3 h-3" />}
                                          {needsReauth ? "Re-auth required" : formatTokenExpiry(account.token_expires_at)}
                                        </div>
                                      </TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-1.5 flex-nowrap">
                                          <TokenLifetimeInfo platform={account.platform} compact />
                                          <ReconnectionFrequencyBadge platform={account.platform} />
                                        </div>
                                      </TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-1.5">
                                          {needsReauth ? (
                                            <TooltipProvider>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <Badge variant="destructive" className="text-xs gap-1 cursor-help">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    Action Required
                                                  </Badge>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                  <p>{account.last_refresh_error || "Connection lost. Please reconnect."}</p>
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          ) : (
                                            <Badge
                                              variant={expired ? "destructive" : "default"}
                                              className={`text-xs ${!expired ? "bg-green-500/10 text-green-500 border-green-500/30" : ""}`}
                                            >
                                              {expired ? "Expired" : "Active"}
                                            </Badge>
                                          )}
                                          {account.platform === "pinterest" && getPinterestAccessLevel() !== "unknown" && (
                                            <TooltipProvider>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span className="inline-flex">
                                                    {getPinterestAccessLevel() === "trial" ? (
                                                      <Badge variant="outline" className="text-xs gap-1 bg-amber-500/10 text-amber-600 border-amber-500/30 cursor-help">
                                                        <ShieldAlert className="w-3 h-3" />Trial
                                                      </Badge>
                                                    ) : (
                                                      <Badge variant="outline" className="text-xs gap-1 bg-blue-500/10 text-blue-600 border-blue-500/30 cursor-help">
                                                        <ShieldCheck className="w-3 h-3" />Standard
                                                      </Badge>
                                                    )}
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                  {getPinterestAccessLevel() === "trial"
                                                    ? "Trial Access - Read-only."
                                                    : "Standard Access - Full write permissions."}
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          )}
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Publishing History Tab */}
          <TabsContent value="calls" className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4">
              <Card noAnimation>
                <CardContent className="pt-4 pb-4">
                  <p className="text-sm text-muted-foreground">Total Posts</p>
                  <p className="text-xl font-bold">{postStats.total}</p>
                </CardContent>
              </Card>
              <Card noAnimation>
                <CardContent className="pt-4 pb-4">
                  <p className="text-sm text-muted-foreground">Manual</p>
                  <p className="text-xl font-bold">{postStats.manual}</p>
                </CardContent>
              </Card>
              <Card noAnimation>
                <CardContent className="pt-4 pb-4">
                  <p className="text-sm text-muted-foreground">API</p>
                  <p className="text-xl font-bold">{postStats.api}</p>
                </CardContent>
              </Card>
            </div>

            {/* Filters */}
            <PostFilters
              search={search}
              onSearchChange={(v) => handleFilterChange(() => setSearch(v))}
              selectedFilter={selectedFilter}
              onFilterChange={(f) => handleFilterChange(() => setSelectedFilter(f))}
              sourceFilter={sourceFilter}
              onSourceFilterChange={(f) => handleFilterChange(() => setSourceFilter(f))}
              platformFilter={platformFilter}
              onPlatformFilterChange={(p) => handleFilterChange(() => setPlatformFilter(p))}
              itemsPerPage={itemsPerPage}
              onItemsPerPageChange={(count) => {
                setItemsPerPage(count);
                setCurrentPage(1);
              }}
            />

            {/* Table */}
            <div className="space-y-4">
              {postsLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : filteredPosts.length === 0 ? (
                <div className="text-center py-16">
                  <div className="w-16 h-16 rounded-full bg-secondary mx-auto flex items-center justify-center mb-4">
                    <Search className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-medium mb-2">No posts found</h3>
                  <p className="text-muted-foreground">
                    {search ? "Try a different search term" : "This user has no publishing history"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="text-sm text-muted-foreground">
                    Showing {startIndex + 1}-{Math.min(endIndex, totalItems)} of {totalItems} posts
                  </div>

                  <HistoryTable
                    posts={paginatedPosts}
                    selectedPosts={selectedPosts}
                    retryingPostId={null}
                    accountsCache={accountsCache}
                    onToggleSelection={togglePostSelection}
                    onSelectAll={selectAllPosts}
                    onDeselectAll={deselectAllPosts}
                    onViewDetails={async (p) => {
                      const post = p as PostWithResults;
                      try {
                        const { data: freshPlatformPosts } = await supabase
                          .from("platform_posts")
                          .select("*")
                          .eq("post_id", post.id);
                        setDetailsPost({
                          ...post,
                          platformResults: (freshPlatformPosts || []) as PlatformPost[],
                        });
                      } catch {
                        setDetailsPost(post);
                      }
                    }}
                    onRetryFailed={noopPost}
                    onRetryWithMedia={noopPost}
                    onDelete={noopPost}
                    isTikTokMediaError={isTikTokMediaError}
                  />

                  {totalPages > 1 && (
                    <Pagination className="mt-6">
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                          />
                        </PaginationItem>
                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter((page) => {
                            if (page === 1 || page === totalPages) return true;
                            if (Math.abs(page - currentPage) <= 1) return true;
                            return false;
                          })
                          .map((page, index, array) => {
                            const prevPage = array[index - 1];
                            const showEllipsis = prevPage && page - prevPage > 1;
                            return (
                              <span key={page} className="flex items-center">
                                {showEllipsis && (
                                  <PaginationItem>
                                    <span className="px-3 text-muted-foreground">...</span>
                                  </PaginationItem>
                                )}
                                <PaginationItem>
                                  <PaginationLink
                                    onClick={() => setCurrentPage(page)}
                                    isActive={currentPage === page}
                                    className="cursor-pointer"
                                  >
                                    {page}
                                  </PaginationLink>
                                </PaginationItem>
                              </span>
                            );
                          })}
                        <PaginationItem>
                          <PaginationNext
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  )}
                </>
              )}
            </div>
          </TabsContent>

          {/* Logs Tab */}
          <TabsContent value="logs" className="space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-3">
              <Select value={logLevelFilter} onValueChange={(v) => { setLogLevelFilter(v); setLogPage(1); }}>
                <SelectTrigger className="w-[150px]">
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
              <Select value={logCategoryFilter} onValueChange={(v) => { setLogCategoryFilter(v); setLogPage(1); }}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="post">Post</SelectItem>
                  <SelectItem value="token">Token</SelectItem>
                  <SelectItem value="edge">Edge Function</SelectItem>
                  <SelectItem value="auth">Auth</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Log entries */}
            {logsLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : userLogs.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <Bug className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p>No logs found for this user.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Showing {((logPage - 1) * logsPerPage) + 1}-{Math.min(logPage * logsPerPage, logCount)} of {logCount} logs
                </p>
                {userLogs.map((log: any) => {
                  const levelIcon = log.level === "error" ? <AlertCircle className="w-4 h-4 text-destructive" /> :
                    log.level === "warn" ? <AlertTriangle className="w-4 h-4 text-yellow-500" /> :
                    log.level === "info" ? <Info className="w-4 h-4 text-blue-500" /> :
                    <CheckCircle className="w-4 h-4 text-muted-foreground" />;
                  const levelVariant = log.level === "error" ? "destructive" as const :
                    log.level === "warn" ? "secondary" as const : "outline" as const;

                  return (
                    <details key={log.id} className="group border rounded-lg">
                      <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50">
                        {levelIcon}
                        <Badge variant={levelVariant} className="text-xs uppercase">{log.level}</Badge>
                        {log.category && (
                          <Badge variant="outline" className="text-xs">{log.category}</Badge>
                        )}
                        {log.source && (
                          <Badge variant="outline" className="text-xs font-mono">{log.source}</Badge>
                        )}
                        <span className="flex-1 text-sm truncate">{log.message}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {format(new Date(log.created_at), "MMM d, HH:mm:ss")}
                        </span>
                      </summary>
                      <div className="px-4 pb-4 pt-2 border-t">
                        {log.metadata && (() => {
                          const meta = typeof log.metadata === "string" ? JSON.parse(log.metadata) : log.metadata;
                          const errorKeys = ["error", "errorMessage", "error_message", "reason"];
                          const errorMsg = errorKeys.map(k => meta[k]).find(v => v);
                          const knownKeys: Record<string, string> = {
                            platform: "Platform", account: "Account", accountId: "Account ID",
                            url: "URL", endpoint: "Endpoint", status_code: "Status Code",
                            duration: "Duration", postId: "Post ID", mediaUrl: "Media URL",
                          };
                          const displayedKeys = new Set([...errorKeys, ...Object.keys(knownKeys), "user"]);
                          const remainingKeys = Object.keys(meta).filter(k => !displayedKeys.has(k));

                          return (
                            <div className="space-y-3">
                              {errorMsg && (
                                <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                                  <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                                  <p className="text-sm text-destructive">{String(errorMsg)}</p>
                                </div>
                              )}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {Object.entries(knownKeys).map(([key, label]) => {
                                  const val = meta[key];
                                  if (val === undefined || val === null) return null;
                                  const strVal = String(val);
                                  const isUrl = strVal.startsWith("http");
                                  return (
                                    <div key={key} className="flex items-center gap-2 text-sm">
                                      <span className="text-muted-foreground font-medium min-w-[100px]">{label}:</span>
                                      {isUrl ? (
                                        <a href={strVal} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1 truncate">
                                          {strVal.slice(0, 60)}... <ExternalLink className="w-3 h-3 shrink-0" />
                                        </a>
                                      ) : (
                                        <span className="font-mono text-xs truncate">{strVal}</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                              {remainingKeys.length > 0 && (
                                <details className="text-xs">
                                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                                    Raw JSON ({remainingKeys.length} more fields)
                                  </summary>
                                  <pre className="mt-2 p-3 bg-muted rounded-md overflow-auto max-h-64 text-xs">
                                    {JSON.stringify(
                                      Object.fromEntries(remainingKeys.map(k => [k, meta[k]])),
                                      null, 2
                                    )}
                                  </pre>
                                </details>
                              )}
                            </div>
                          );
                        })()}
                        {!log.metadata && (
                          <p className="text-sm text-muted-foreground italic">No additional details.</p>
                        )}

                        {/* AI Analysis Panel */}
                        {userAnalysisResults.has(log.id) && (
                          <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                              <Sparkles className="w-4 h-4 text-primary" />
                              AI Analysis
                            </div>
                            <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3">
                              <div className="flex items-center gap-2 mb-1">
                                <Lightbulb className="w-4 h-4 text-blue-500" />
                                <span className="text-xs font-semibold text-blue-500">What Happened</span>
                              </div>
                              <p className="text-sm">{userAnalysisResults.get(log.id)!.explanation}</p>
                            </div>
                            <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3">
                              <div className="flex items-center gap-2 mb-1">
                                <Target className="w-4 h-4 text-yellow-500" />
                                <span className="text-xs font-semibold text-yellow-500">Root Cause</span>
                              </div>
                              <p className="text-sm">{userAnalysisResults.get(log.id)!.root_cause}</p>
                            </div>
                            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <MessageSquare className="w-4 h-4 text-primary" />
                                  <span className="text-xs font-semibold text-primary">Lovable Prompt</span>
                                </div>
                                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                                  onClick={() => handleCopyUserPrompt(log.id, userAnalysisResults.get(log.id)!.lovable_prompt)}>
                                  {copiedPromptId === log.id ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy Prompt</>}
                                </Button>
                              </div>
                              <pre className="text-xs bg-background rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap font-mono border">
                                {userAnalysisResults.get(log.id)!.lovable_prompt}
                              </pre>
                            </div>
                          </div>
                        )}

                        {/* Analyze Button */}
                        <div className="mt-2 flex justify-end">
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                            disabled={analyzingLogId === log.id}
                            onClick={() => handleAnalyzeUserLog(log)}>
                            {analyzingLogId === log.id ? (
                              <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing...</>
                            ) : userAnalysisResults.has(log.id) ? (
                              <><Sparkles className="w-3 h-3 text-primary" /> Re-analyze</>
                            ) : (
                              <><Sparkles className="w-3 h-3" /> Analyze</>
                            )}
                          </Button>
                        </div>
                      </div>
                    </details>
                  );
                })}

                {/* Pagination */}
                {Math.ceil(logCount / logsPerPage) > 1 && (
                  <Pagination className="mt-4">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => setLogPage(p => Math.max(1, p - 1))}
                          className={logPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                      {Array.from({ length: Math.min(5, Math.ceil(logCount / logsPerPage)) }, (_, i) => {
                        const totalLogPages = Math.ceil(logCount / logsPerPage);
                        let page: number;
                        if (totalLogPages <= 5) {
                          page = i + 1;
                        } else if (logPage <= 3) {
                          page = i + 1;
                        } else if (logPage >= totalLogPages - 2) {
                          page = totalLogPages - 4 + i;
                        } else {
                          page = logPage - 2 + i;
                        }
                        return (
                          <PaginationItem key={page}>
                            <PaginationLink
                              onClick={() => setLogPage(page)}
                              isActive={logPage === page}
                              className="cursor-pointer"
                            >
                              {page}
                            </PaginationLink>
                          </PaginationItem>
                        );
                      })}
                      <PaginationItem>
                        <PaginationNext
                          onClick={() => setLogPage(p => Math.min(Math.ceil(logCount / logsPerPage), p + 1))}
                          className={logPage >= Math.ceil(logCount / logsPerPage) ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Post Details Dialog */}
      <PostDetailsDialog
        post={detailsPost as any}
        onClose={() => setDetailsPost(null)}
        media={detailsMedia}
        mediaLoading={detailsMediaLoading}
        accountsCache={accountsCache}
      />
    </AdminLayout>
  );
}
