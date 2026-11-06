/**
 * Database reads for ai-generation-status, and the answer for background image jobs. A failed read
 * is a retryable 503: answering "not found" or "expired" on a transient error would end the
 * browser's wait on an image that exists. Worker image jobs must never reach index.ts's provider
 * or 30-minute branches, which would refund a reservation the worker never made.
 */
// deno-lint-ignore-file no-explicit-any
export const WORKER_IMAGE_POLL_SECONDS = 3;
export const RETRYABLE_READ_BODY = { success: false, retryable: true, error: "Could not read the generation status. Retrying." };
export type OwnedJobRead = { kind: "found"; job: any } | { kind: "missing" } | { kind: "error"; message: string };

const paramsOf = (job: { params: unknown }) =>
  job.params && typeof job.params === "object" ? (job.params as Record<string, unknown>) : {};

export async function loadOwnedJob(db: any, jobId: unknown, userId: string): Promise<OwnedJobRead> {
  if (typeof jobId !== "string" || jobId.length === 0) return { kind: "missing" };
  const { data, error } = await db.from("ai_generation_jobs").select("*").eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) return { kind: "error", message: String(error.message ?? error) };
  return data ? { kind: "found", job: data } : { kind: "missing" };
}

export function isWorkerImageJob(job: { modality: string; params: unknown }): boolean {
  return job.modality === "image" && paramsOf(job).worker === true;
}

export async function answerWorkerImageJob(db: any, job: any): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = paramsOf(job);
  if (job.status === "succeeded") {
    let imageUrl: string | null = job.result_url ?? null;
    if (!imageUrl) {
      const { data, error } = await db.from("ai_image_job_payloads").select("result_data_url").eq("job_id", job.id).maybeSingle();
      if (error) return { status: 503, body: RETRYABLE_READ_BODY };
      imageUrl = data?.result_data_url ?? null;
    }
    if (!imageUrl) {
      return { status: 200, body: { success: true, status: "failed", error: "This generated image has expired. Please generate it again.", errorCode: "ai_result_expired" } };
    }
    return { status: 200, body: { success: true, status: "succeeded", imageUrl, url: imageUrl, description: params.description ?? null } };
  }
  if (job.status === "failed" || job.status === "timeout") {
    return { status: 200, body: { success: true, status: job.status, error: job.error,
      errorCode: typeof params.error_code === "string" ? params.error_code : "ai_error" } };
  }
  return { status: 200, body: { success: true, status: job.status === "queued" ? "queued" : "running", pollAfterSeconds: WORKER_IMAGE_POLL_SECONDS } };
}
