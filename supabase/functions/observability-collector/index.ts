import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("[OBSERVABILITY] Starting health metrics collection...");

    const now = new Date();
    const windowStart = new Date(now.getTime() - 5 * 60 * 1000); // Last 5 minutes
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = now.toISOString();

    // Collect token health metrics
    const { data: tokenStats } = await supabase
      .from("social_accounts")
      .select("id, platform, is_active, needs_reauth, failure_count");

    const totalTokens = tokenStats?.length || 0;
    const healthyTokens = tokenStats?.filter(t => t.is_active && !t.needs_reauth && (t.failure_count || 0) < 3).length || 0;
    const tokenHealthScore = totalTokens > 0 ? Math.round((healthyTokens / totalTokens) * 100) : 100;
    const unhealthyTokensCount = totalTokens - healthyTokens;

    // Collect edge function metrics from system_logs
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentLogs } = await supabase
      .from("system_logs")
      .select("level, source, category, metadata, created_at")
      .gte("created_at", oneHourAgo);

    const totalLogs = recentLogs?.length || 0;
    const errorLogs = recentLogs?.filter(l => l.level === "error").length || 0;
    const edgeFunctionErrors = recentLogs?.filter(l => l.source?.includes("edge") && l.level === "error").length || 0;

    // Calculate edge functions health (inversely proportional to error rate)
    const edgeFunctionsHealth = totalLogs > 0 ? Math.round(Math.max(0, 100 - (errorLogs / totalLogs) * 500)) : 100;

    // Collect per-function metrics from system_logs
    const functionMetricsMap = new Map<string, {
      total: number;
      success: number;
      errors: number;
      durations: number[];
    }>();

    // Parse edge function logs to extract per-function metrics
    const edgeFunctionLogs = recentLogs?.filter(l => 
      l.category === "edge" || l.source?.startsWith("edge-") || l.source?.includes("function")
    ) || [];

    for (const log of edgeFunctionLogs) {
      // Extract function name from source
      const functionName = log.source?.replace(/^edge-/, '').replace(/-function$/, '') || 'unknown';
      
      const existing = functionMetricsMap.get(functionName) || {
        total: 0,
        success: 0,
        errors: 0,
        durations: [],
      };

      existing.total++;
      if (log.level === "error") {
        existing.errors++;
      } else {
        existing.success++;
      }

      // Extract duration if available in metadata
      const duration = (log.metadata as Record<string, unknown>)?.duration_ms as number;
      if (typeof duration === "number") {
        existing.durations.push(duration);
      }

      functionMetricsMap.set(functionName, existing);
    }

    // Store per-function metrics
    for (const [functionName, metrics] of functionMetricsMap.entries()) {
      const avgDuration = metrics.durations.length > 0 
        ? metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length 
        : null;
      const maxDuration = metrics.durations.length > 0 ? Math.max(...metrics.durations) : null;
      const minDuration = metrics.durations.length > 0 ? Math.min(...metrics.durations) : null;

      await supabase
        .from("observability_metrics")
        .insert({
          metric_type: "edge_function",
          metric_name: functionName,
          metric_category: "performance",
          total_count: metrics.total,
          success_count: metrics.success,
          error_count: metrics.errors,
          avg_duration_ms: avgDuration,
          max_duration_ms: maxDuration,
          min_duration_ms: minDuration,
          window_start: windowStartIso,
          window_end: windowEndIso,
          metadata: {
            source: "observability-collector",
          },
        });
    }

    // Check cron job health from recent execution logs
    const { data: recentTokenRefreshes } = await supabase
      .from("token_refresh_history")
      .select("status")
      .gte("created_at", oneHourAgo);

    const totalRefreshes = recentTokenRefreshes?.length || 0;
    const failedRefreshes = recentTokenRefreshes?.filter(r => r.status === "failed").length || 0;
    const cronHealth = totalRefreshes > 0 ? Math.round(((totalRefreshes - failedRefreshes) / totalRefreshes) * 100) : 100;

    // Check database health (simple connectivity check + query performance)
    const dbStartTime = Date.now();
    const { error: dbError } = await supabase.from("profiles").select("id").limit(1);
    const dbQueryTime = Date.now() - dbStartTime;
    
    // Database health: 100 if < 100ms, decreasing for slower queries
    const databaseHealth = dbError ? 0 : Math.max(0, Math.round(100 - (dbQueryTime / 10)));

    // Calculate overall health score (weighted average)
    const overallHealthScore = Math.round(
      (tokenHealthScore * 0.3) +
      (edgeFunctionsHealth * 0.3) +
      (databaseHealth * 0.2) +
      (cronHealth * 0.2)
    );

    // Store the health snapshot
    const { data: snapshot, error: snapshotError } = await supabase
      .from("observability_health_snapshots")
      .insert({
        overall_health_score: overallHealthScore,
        edge_functions_health: edgeFunctionsHealth,
        database_health: databaseHealth,
        token_health: tokenHealthScore,
        cron_health: cronHealth,
        active_errors_count: errorLogs,
        failed_functions_count: edgeFunctionErrors,
        slow_queries_count: dbQueryTime > 500 ? 1 : 0,
        unhealthy_tokens_count: unhealthyTokensCount,
        metrics_breakdown: {
          total_tokens: totalTokens,
          healthy_tokens: healthyTokens,
          total_logs_1h: totalLogs,
          error_logs_1h: errorLogs,
          db_query_time_ms: dbQueryTime,
          cron_total_1h: totalRefreshes,
          cron_failed_1h: failedRefreshes,
          functions_tracked: functionMetricsMap.size,
        },
      })
      .select()
      .single();

    if (snapshotError) {
      console.error("[OBSERVABILITY] Error storing snapshot:", snapshotError);
      throw snapshotError;
    }

    console.log("[OBSERVABILITY] Health snapshot captured:", {
      overall: overallHealthScore,
      functions: edgeFunctionsHealth,
      database: databaseHealth,
      tokens: tokenHealthScore,
      cron: cronHealth,
      functionsTracked: functionMetricsMap.size,
    });

    // Clean up old snapshots (keep last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("observability_health_snapshots")
      .delete()
      .lt("captured_at", sevenDaysAgo);

    // Clean up old function metrics (keep last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("observability_metrics")
      .delete()
      .lt("window_end", oneDayAgo);

    // Clean up old system logs (keep last 48 hours)
    // log_analyses entries cascade-delete automatically via FK
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { error: logCleanupError } = await supabase
      .from("system_logs")
      .delete()
      .lt("created_at", twoDaysAgo);

    if (logCleanupError) {
      console.error("[OBSERVABILITY] Error cleaning up system_logs:", logCleanupError);
    } else {
      console.log("[OBSERVABILITY] Cleaned up system_logs older than 48 hours");
    }

    return new Response(
      JSON.stringify({
        success: true,
        snapshot: snapshot,
        functionsTracked: functionMetricsMap.size,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[OBSERVABILITY] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
