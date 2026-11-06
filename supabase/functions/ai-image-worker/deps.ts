import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { defaultImageRunDeps, runImageGeneration } from "../generate-image/runImageGeneration.ts";
import type { AiImageWorkerPorts, ClaimedImageJob } from "./worker.ts";

export function createAiImageWorkerPorts(admin: SupabaseClient, workerStartedAtMs: number): AiImageWorkerPorts {
  const nowIso = () => new Date().toISOString();
  return {
    now: () => Date.now(),
    workerStartedAtMs,
    async claim(limit, lease, maxPerUser) {
      const { data, error } = await admin.rpc("claim_ai_image_jobs", { p_limit: limit, p_lease: lease, p_max_per_user: maxPerUser });
      if (error) throw new Error(`claim_ai_image_jobs: ${error.message}`);
      return (data ?? []) as ClaimedImageJob[];
    },
    async loadReferences(jobId) {
      const { data, error } = await admin.from("ai_image_job_payloads").select("reference_images").eq("job_id", jobId).maybeSingle();
      if (error) throw new Error(`load payload: ${error.message}`);
      if (!data) throw new Error(`payload missing for ${jobId}`);
      return data.reference_images ?? [];
    },
    async markDispatched(jobId, claimToken) {
      const { data, error } = await admin.from("ai_generation_jobs")
        .update({ dispatched_at: nowIso(), updated_at: nowIso() })
        .eq("id", jobId).eq("claim_token", claimToken).eq("status", "running").is("dispatched_at", null)
        .select("id");
      return !error && (data?.length ?? 0) === 1;
    },
    run: (job, onDispatch) => runImageGeneration(defaultImageRunDeps(admin, { onDispatch, recordHiggsfieldSuccess: async () => {} }), job),
    async complete(c, signal) {
      const { data, error } = await admin.rpc("complete_ai_image_job", {
        p_job_id: c.jobId, p_claim_token: c.claimToken, p_status: c.status, p_result_url: c.resultUrl,
        p_result_data_url: c.resultDataUrl, p_error: c.error, p_provider: c.provider, p_model_id: c.modelId,
        p_credential_source: c.credentialSource, p_params: c.params,
      }).abortSignal(signal);
      if (error) throw new Error(`complete_ai_image_job: ${error.message}`);
      return data === true;
    },
    async log(level, userId, message, metadata) {
      const { error } = await admin.from("system_logs").insert({ level, category: "ai", source: "generate-image", message, user_id: userId, metadata });
      if (error) console.error("[ai-image-worker] system_logs insert failed:", error.message);
    },
  };
}
