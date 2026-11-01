import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.25.76";
import { createLogger } from "../_shared/logging.ts";
import {
  debugThreadsToken,
  classifyMetaError,
  type SelectedThreadsAccount,
} from "../_shared/threads-debug.ts";
import { serviceRoleCallerUserId } from "../_shared/auth-helper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const selectionSchema = z.object({
  accountId: z.string().uuid().optional(),
  periodDays: z.unknown().optional(),
});

const ENGLISH_TITLES: Record<string, string> = {
  views: "Views", likes: "Likes", replies: "Replies", reposts: "Reposts", quotes: "Quotes", followers_count: "Followers",
};
const ENGLISH_DESCRIPTIONS: Record<string, string> = {
  views: "The number of times your content was viewed",
  likes: "The number of likes on your content",
  replies: "The number of replies on your content",
  reposts: "The number of times your content was reposted",
  quotes: "The number of times your content was quoted",
  followers_count: "Your total number of followers",
};

// Metrics that support time_series breakdown
const TIME_SERIES_METRICS = ["views", "likes", "replies", "reposts", "quotes"];
const ALL_PROFILE_METRICS = ["views", "likes", "replies", "reposts", "quotes", "followers_count"];

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function structured(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ok: false, ...body }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fetchProfileTotals(threadsUserId: string, accessToken: string, since: number, until: number) {
  const url = `https://graph.threads.net/v1.0/${threadsUserId}/threads_insights?metric=${ALL_PROFILE_METRICS.join(",")}&since=${since}&until=${until}&locale=en_US&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function fetchProfileTimeSeries(threadsUserId: string, accessToken: string, since: number, until: number) {
  // time_series breakdown for supported metrics
  const url = `https://graph.threads.net/v1.0/${threadsUserId}/threads_insights?metric=${TIME_SERIES_METRICS.join(",")}&since=${since}&until=${until}&metric_type=time_series&locale=en_US&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const logger = createLogger(supabase, "threads-insights", "edge");
  let userId: string | undefined;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const token = authHeader.replace("Bearer ", "");

    const serviceUserId = await serviceRoleCallerUserId(req);
    if (serviceUserId) {
      userId = serviceUserId;
    } else {
      const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);
      if (claimsError || !claimsData?.claims) throw new Error("Unauthorized");
      userId = claimsData.claims.sub as string;
    }

    // Parse body
    let periodDays = 7;
    const body = await req.json().catch(() => null);
    const selection = selectionSchema.safeParse(body);
    if (!selection.success) {
      await logger.warn("Invalid Threads insights request", {
        event: "invalid_request", platform: "threads",
      }, userId);
      return structured({ reason: "invalid_request", message: "Invalid Threads insights request." }, 400);
    }
    const { accountId, periodDays: requestedPeriod } = selection.data;
    if (typeof requestedPeriod === "number" && [7, 14, 30, 90].includes(requestedPeriod)) {
      periodDays = requestedPeriod;
    }

    let accountQuery = supabase
      .from("social_accounts")
      .select("id, user_id, platform_user_id, platform_username, access_token, connected_at, updated_at, token_expires_at")
      .eq("user_id", userId)
      .eq("platform", "threads")
      .eq("is_active", true);
    accountQuery = accountId
      ? accountQuery.eq("id", accountId)
      : accountQuery.order("connected_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false });
    const { data: accounts, error: accountError } = await accountQuery.limit(1).returns<SelectedThreadsAccount[]>();
    if (accountError) {
      await logger.error("Threads insights account read failed", {
        event: "account_read_failed", platform: "threads", error_code: accountError.code,
      }, userId);
      return structured({ reason: "storage_error", message: "Unable to load Threads account. Please retry." }, 503);
    }
    const account = accounts?.[0] ?? null;
    if (accountId && !account) {
      await logger.warn("Threads insights account not found", {
        event: "account_not_found", platform: "threads",
      }, userId);
      return structured({ reason: "account_not_found", message: "Threads account not found." }, 404);
    }

    if (!account?.access_token) {
      await logger.warn("No Threads account connected for insights", {
        event: "no_account",
        platform: "threads",
      }, userId);
      return structured({
        reason: "no_account",
        message: "No Threads account connected. Please connect your Threads account first.",
        needsConnection: true,
      });
    }

    await logger.info("Threads Insights — selected account", {
      event: "selected_account",
      platform: "threads",
      social_account_id: account.id,
      periodDays,
    }, userId);

    const preflight = await debugThreadsToken(account.access_token);
    if (!preflight.ok) {
      const cls = classifyMetaError({
        code: preflight.errorCode,
        error_subcode: preflight.errorSubcode,
        message: preflight.errorMessage,
        type: preflight.errorType,
      });
      const needsReauth = cls.reason === "invalid_token" || cls.reason === "expired_token";
      return structured({
        reason: needsReauth ? cls.reason : (cls.reason === "unknown" ? "invalid_token" : cls.reason),
        message: cls.message || "Threads token preflight failed",
        meta: { code: cls.code, subcode: cls.subcode, type: cls.type },
        needsReauth,
      });
    }

    const threadsUserId = preflight.threadsUserId || account.platform_user_id;
    const accessToken = account.access_token;

    // Compute period windows (UNIX seconds)
    const nowSec = Math.floor(Date.now() / 1000);
    const periodSec = periodDays * 24 * 60 * 60;
    const sinceSec = nowSec - periodSec;
    const untilSec = nowSec;
    const prevSinceSec = sinceSec - periodSec;
    const prevUntilSec = sinceSec;

    // Fetch current period totals + previous period totals + time series in parallel
    const [currentTotals, previousTotals, timeSeries] = await Promise.all([
      fetchProfileTotals(threadsUserId, accessToken, sinceSec, untilSec),
      fetchProfileTotals(threadsUserId, accessToken, prevSinceSec, prevUntilSec),
      fetchProfileTimeSeries(threadsUserId, accessToken, sinceSec, untilSec),
    ]);

    await logger.info("Threads Insights — period requests", {
      event: "period_requests",
      platform: "threads",
      periodDays,
      since: sinceSec,
      until: untilSec,
      current_status: currentTotals.status,
      previous_status: previousTotals.status,
      time_series_status: timeSeries.status,
      current_error: currentTotals.data?.error,
    }, userId);

    if (currentTotals.data?.error) {
      const cls = classifyMetaError(currentTotals.data.error);
      return structured({
        reason: cls.reason,
        message: cls.message,
        meta: { code: cls.code, subcode: cls.subcode, type: cls.type },
        needsPermission: cls.reason === "permission_not_approved" || cls.reason === "missing_scope",
        needsReauth: cls.reason === "invalid_token" || cls.reason === "expired_token",
      });
    }

    // Map current period values
    const currentMap: Record<string, number> = {};
    if (Array.isArray(currentTotals.data?.data)) {
      for (const m of currentTotals.data.data) {
        currentMap[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
      }
    }

    // Map previous period values
    const previousMap: Record<string, number> = {};
    if (Array.isArray(previousTotals.data?.data)) {
      for (const m of previousTotals.data.data) {
        previousMap[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
      }
    }

    // Map daily time-series values
    const dailyMap: Record<string, number[]> = {};
    if (Array.isArray(timeSeries.data?.data)) {
      for (const m of timeSeries.data.data) {
        const values = Array.isArray(m.values) ? m.values.map((v: any) => Number(v.value) || 0) : [];
        dailyMap[m.name] = values;
      }
    }

    // Build insights payload
    const metricsData: Record<string, any> = {};
    for (const key of ALL_PROFILE_METRICS) {
      const value = currentMap[key] ?? 0;
      const previous = previousMap[key] ?? 0;
      const daily = dailyMap[key] ?? [];
      // followers_count from time-series may not be supported — fall back gracefully
      metricsData[key] = {
        title: ENGLISH_TITLES[key] || key,
        description: ENGLISH_DESCRIPTIONS[key] || "",
        value,
        previous,
        daily,
        period: `${periodDays}d`,
      };
    }

    // Recent posts
    const postsUrl = `https://graph.threads.net/v1.0/${threadsUserId}/threads?fields=id,text,timestamp,media_type,media_url,permalink,shortcode,thumbnail_url&limit=25&access_token=${encodeURIComponent(accessToken)}`;
    let posts: any[] = [];
    try {
      const postsRes = await fetch(postsUrl);
      const postsData = await postsRes.json();
      if (postsData.data && Array.isArray(postsData.data)) posts = postsData.data;
    } catch (e) {
      await logger.warn("Error fetching Threads posts", {
        event: "posts_fetch_error",
        platform: "threads",
        error_message: (e as Error).message,
      }, userId);
    }

    // Per-post insights
    const postsWithMetrics: any[] = [];
    for (const post of posts) {
      const postMetrics: Record<string, number> = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };
      try {
        const piRes = await fetch(`https://graph.threads.net/v1.0/${post.id}/insights?metric=views,likes,replies,reposts,quotes,shares&access_token=${encodeURIComponent(accessToken)}`);
        const piData = await piRes.json();
        if (piData.data && Array.isArray(piData.data)) {
          for (const m of piData.data) {
            postMetrics[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
          }
        }
      } catch { /* skip */ }

      postsWithMetrics.push({
        id: post.id,
        text: post.text || "",
        timestamp: post.timestamp,
        media_type: post.media_type,
        media_url: post.media_url,
        permalink: post.permalink,
        thumbnail_url: post.thumbnail_url,
        metrics: postMetrics,
      });
    }

    // Activity: posts in current vs previous period
    const sinceMs = sinceSec * 1000;
    const prevSinceMs = prevSinceSec * 1000;
    const prevUntilMs = prevUntilSec * 1000;

    const currentPosts = postsWithMetrics.filter(p => {
      const t = new Date(p.timestamp).getTime();
      return !isNaN(t) && t >= sinceMs;
    });
    const previousPosts = postsWithMetrics.filter(p => {
      const t = new Date(p.timestamp).getTime();
      return !isNaN(t) && t >= prevSinceMs && t < prevUntilMs;
    });

    // Build daily_posts array (one bucket per day in period)
    const dailyPosts: number[] = new Array(periodDays).fill(0);
    for (const p of currentPosts) {
      const t = new Date(p.timestamp).getTime();
      const dayIndex = Math.floor((t - sinceMs) / (24 * 60 * 60 * 1000));
      if (dayIndex >= 0 && dayIndex < periodDays) dailyPosts[dayIndex]++;
    }

    const activity = {
      current_posts: currentPosts.length,
      previous_posts: previousPosts.length,
      daily_posts: dailyPosts,
    };

    // Aggregated stats (kept from original logic, based on all fetched posts)
    const totalPosts = postsWithMetrics.length;
    let totalViews = 0, totalEngagement = 0;
    for (const p of postsWithMetrics) {
      totalViews += p.metrics.views || 0;
      totalEngagement += (p.metrics.likes || 0) + (p.metrics.replies || 0) + (p.metrics.reposts || 0) + (p.metrics.quotes || 0) + (p.metrics.shares || 0);
    }

    let postingFrequency = "N/A";
    if (totalPosts >= 2) {
      const timestamps = postsWithMetrics
        .map(p => new Date(p.timestamp).getTime())
        .filter(t => !isNaN(t))
        .sort((a, b) => a - b);
      if (timestamps.length >= 2) {
        const spanMs = timestamps[timestamps.length - 1] - timestamps[0];
        const spanWeeks = spanMs / (1000 * 60 * 60 * 24 * 7);
        if (spanWeeks > 0) postingFrequency = `${(timestamps.length / spanWeeks).toFixed(1)} posts/week`;
      }
    }

    const aggregated = {
      avg_views_per_post: totalPosts > 0 ? Math.round(totalViews / totalPosts) : 0,
      avg_engagement_per_post: totalPosts > 0 ? Math.round(totalEngagement / totalPosts) : 0,
      total_posts: totalPosts,
      posting_frequency: postingFrequency,
    };

    await logger.info("Threads Insights fetched successfully", {
      event: "insights_success",
      platform: "threads",
      metrics_count: Object.keys(metricsData).length,
      posts_count: totalPosts,
      period_days: periodDays,
      username: account.platform_username,
    }, userId);

    return ok({
      insights: metricsData,
      posts: postsWithMetrics,
      aggregated,
      activity,
      periodDays,
      username: account.platform_username,
      threadsUserId,
    });

  } catch (error) {
    const errMsg = (error as Error).message || "Insights fetch failed";
    await logger.error("Threads Insights — internal error", {
      event: "insights_internal_error",
      platform: "threads",
      error_message: errMsg,
      error_stack: (error as Error).stack,
    }, userId);
    return structured({ reason: "unknown", message: errMsg });
  }
}

if (import.meta.main) Deno.serve(handler);
