import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import type {
  BackgroundJobsWorkerPorts,
  ClaimedJob,
  JobHandler,
} from "./worker.ts";

export function createBackgroundJobsWorkerPorts(
  admin: SupabaseClient,
  workerStartedAtMs: number,
  handlers: Record<string, JobHandler>,
): BackgroundJobsWorkerPorts {
  return {
    now: () => Date.now(),
    workerStartedAtMs,
    handlers,
    async claim(kinds, lease) {
      const { data, error } = await admin.rpc("claim_background_job", {
        p_kinds: kinds,
        p_lease: lease,
      });
      if (error) throw new Error(`claim_background_job: ${error.message}`);
      const rows = (data ?? []) as ClaimedJob[];
      return rows[0] ?? null;
    },
    async continueJob(job, outcome) {
      const { data, error } = await admin.rpc("continue_background_job", {
        p_id: job.id,
        p_token: job.claim_token,
        p_payload: outcome.payload ?? job.payload,
        p_progress: outcome.progress,
        p_run_after: outcome.runAfterMs ? new Date(Date.now() + outcome.runAfterMs).toISOString() : null,
      });
      if (error) throw new Error(`continue_background_job: ${error.message}`);
      return data === true;
    },
    async complete(job, status, result, error) {
      const { data, error: rpcError } = await admin.rpc("complete_background_job", {
        p_id: job.id,
        p_token: job.claim_token,
        p_status: status,
        p_result: result,
        p_error: error,
      });
      if (rpcError) throw new Error(`complete_background_job: ${rpcError.message}`);
      return data === true;
    },
    async log(level, userId, message, metadata) {
      const { error } = await admin.from("system_logs").insert({
        level,
        category: "system",
        source: "background-jobs-worker",
        message,
        user_id: userId,
        metadata,
      });
      if (error) console.error("[background-jobs-worker] system_logs insert failed:", error.message);
    },
  };
}
