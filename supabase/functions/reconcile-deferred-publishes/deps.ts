/** The real ports: the claim and sweep RPCs, and process-post in resume mode. */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logToDatabase } from "../_shared/logging.ts";
import type { ClaimedRow, ReconcilePorts } from "./run.ts";

/** Under this function's own 60 s, so a slow resume cannot take the whole run down with it. */
const RESUME_TIMEOUT_MS = 50_000;

export function createReconcilePorts(): ReconcilePorts {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("reconcile backend unavailable");
  const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey);

  return {
    async claim(limit) {
      const { data, error } = await admin.rpc("claim_deferred_publishes", { p_limit: limit });
      if (error) throw new Error(`claim_deferred_publishes failed: ${error.message}`);
      return (data ?? []) as ClaimedRow[];
    },
    async resume(row) {
      const response = await fetch(`${supabaseUrl}/functions/v1/process-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ post_id: row.post_id, resume_platform_post_id: row.platform_post_id }),
        signal: AbortSignal.timeout(RESUME_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null) as { status?: string; error?: string } | null;
      return response.ok
        ? { ok: true, status: body?.status }
        : { ok: false, error: `process-post HTTP ${response.status}: ${body?.error ?? "no body"}` };
    },
    async sweep() {
      const { data, error } = await admin.rpc("sweep_stale_processing_posts");
      if (error) throw new Error(`sweep_stale_processing_posts failed: ${error.message}`);
      const result = (data ?? {}) as { posts?: number; rows_failed?: number };
      return { posts: result.posts ?? 0, rows_failed: result.rows_failed ?? 0 };
    },
    log(level, message, metadata) {
      return logToDatabase(admin, { level, category: "post", source: "reconcile-deferred-publishes", message, metadata });
    },
  };
}
