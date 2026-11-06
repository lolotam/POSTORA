// Background image generation worker. Decisions live here; deps.ts adapts them to Postgres.
import { redactProviderError } from "../_shared/ai-routing-errors.ts";
import { describeImageFailure } from "../generate-image/imageFailure.ts";
import type { CallBudget } from "../generate-image/callBudget.ts";
import type { ImageJobInput, ImageRunResult } from "../generate-image/runImageGeneration.ts";
import type { ReferenceInput } from "../_shared/image-references.ts";

export const AI_IMAGE_WORKER_LIMITS = {
  lease: "3 minutes",            // > workerLifetimeMs: a live worker never loses its lease
  tickBudgetMs: 50_000,
  workerLifetimeMs: 150_000,     // edge runtime workerTimeoutMs
  saveReserveMs: 10_000,         // time kept back to write the result
  minRemainingToClaimMs: 100_000,
  maxRunningPerUser: 2,          // enforced atomically by claim_ai_image_jobs
} as const;

export interface ClaimedImageJob { id: string; user_id: string; claim_token: string; params: Record<string, unknown> }
export interface ImageJobCompletion { jobId: string; claimToken: string; status: "succeeded" | "failed"; resultUrl: string | null;
  resultDataUrl: string | null; error: string | null; provider: string | null; modelId: string | null; credentialSource: string | null;
  params: Record<string, unknown> }
export interface AiImageWorkerPorts {
  now(): number;
  workerStartedAtMs: number;
  claim(limit: number, lease: string, maxPerUser: number): Promise<ClaimedImageJob[]>;
  loadReferences(jobId: string): Promise<ReferenceInput[]>;          // throws if the payload row is missing
  markDispatched(jobId: string, claimToken: string): Promise<boolean>;
  run(job: ImageJobInput, onDispatch: () => Promise<boolean>): Promise<ImageRunResult>;
  complete(c: ImageJobCompletion): Promise<boolean>;
  log(level: "info" | "error", userId: string, message: string, metadata: Record<string, unknown>): Promise<void>;
}
export interface AiImageWorkerSummary { claimed: number; succeeded: number; failed: number; lost: number; stoppedForLifetime: boolean }


const asText = (v: unknown) => (typeof v === "string" ? v : undefined);

export function completionFor(job: ClaimedImageJob, r: ImageRunResult | { kind: "threw"; message: string }): ImageJobCompletion | null {
  const base = { jobId: job.id, claimToken: job.claim_token, resultUrl: null, resultDataUrl: null, provider: null, modelId: null, credentialSource: null };
  switch (r.kind) {
    case "lease_lost":
      return null;
    case "succeeded": {
      const inline = r.imageUrl.startsWith("data:");
      return { ...base, status: "succeeded", error: null, resultUrl: inline ? null : r.imageUrl, resultDataUrl: inline ? r.imageUrl : null,
        provider: r.usedModel.provider_code, modelId: r.usedModel.model_id, credentialSource: r.credentialSource,
        params: { description: r.description, chain_source: r.usedModel.source, error_code: null } };
    }
    case "refused":
      return { ...base, status: "failed", error: r.message, params: { error_code: r.errorCode } };
    case "outcome_unknown":
      return { ...base, status: "failed", provider: r.usedModel.provider_code, modelId: r.usedModel.model_id, credentialSource: r.credentialSource,
        error: "The image provider did not confirm the result. Check your Higgsfield history before trying again.",
        params: { error_code: "ai_outcome_unknown" } };
    default: {
      const { code, message } = describeImageFailure(r.message);
      return { ...base, status: "failed", error: redactProviderError(message, ""), params: { error_code: code } };
    }
  }
}

export async function runAiImageWorker(ports: AiImageWorkerPorts): Promise<AiImageWorkerSummary> {
  const L = AI_IMAGE_WORKER_LIMITS;
  const tickStartedAt = ports.now();
  const deadlineMs = ports.workerStartedAtMs + L.workerLifetimeMs - L.saveReserveMs;
  const budget: CallBudget = { deadlineMs, now: () => ports.now(), signal: (ms) => AbortSignal.timeout(ms) };
  const summary: AiImageWorkerSummary = { claimed: 0, succeeded: 0, failed: 0, lost: 0, stoppedForLifetime: false };

  while (ports.now() - tickStartedAt < L.tickBudgetMs) {
    if (ports.workerStartedAtMs + L.workerLifetimeMs - ports.now() < L.minRemainingToClaimMs) {
      summary.stoppedForLifetime = true;
      break;
    }
    const [job] = await ports.claim(1, L.lease, L.maxRunningPerUser);
    if (!job) break;
    summary.claimed++;

    let result: ImageRunResult | { kind: "threw"; message: string };
    try {
      const input: ImageJobInput = {
        userId: job.user_id, prompt: asText(job.params.prompt) ?? "", requestedModel: asText(job.params.requestedModel),
        aspectRatio: asText(job.params.aspectRatio), quality: asText(job.params.quality),
        references: await ports.loadReferences(job.id), budget,
      };
      result = await ports.run(input, () => ports.markDispatched(job.id, job.claim_token));
    } catch (error) {
      result = { kind: "threw", message: error instanceof Error ? error.message : String(error) };
    }

    const completion = completionFor(job, result);
    if (!completion || !(await ports.complete(completion))) {
      summary.lost++;
      console.warn(`[ai-image-worker] job ${job.id}: lease lost, result not written`);
      continue;
    }
    if (completion.status === "succeeded") summary.succeeded++; else summary.failed++;
    await ports.log(completion.status === "succeeded" ? "info" : "error", job.user_id,
      completion.status === "succeeded"
        ? `Image generated using ${completion.provider}/${completion.modelId} (background)`
        : `Image generation failed: ${completion.error}`,
      { feature: "image_generation", async: true, job_id: job.id, error_code: completion.params.error_code ?? null,
        success: completion.status === "succeeded" });
  }
  return summary;
}
