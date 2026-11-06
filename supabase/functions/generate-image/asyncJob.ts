import type { ReferenceInput } from "../_shared/image-references.ts";

const KICK_TIMEOUT_MS = 10_000;

export function buildEnqueueArgs(
  userId: string,
  input: { prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string },
  references: ReferenceInput[],
) {
  return {
    p_user_id: userId,
    p_model_id: input.requestedModel ?? null,
    p_params: {
      prompt: input.prompt,
      aspectRatio: input.aspectRatio ?? null,
      quality: input.quality ?? null,
      requestedModel: input.requestedModel ?? null,
      // Non-terminal job params are scanned by the media-retention sweep, so a queued
      // job's library references stay protected until the worker has read them.
      reference_urls: references.map((r) => r.url).filter((u) => !u.startsWith("data:")),
    },
    p_references: references,
  };
}

/** The worker answers 202 at once; cron is the safety net if this kick is lost. */
export async function kickAiImageWorker(fetchFn: typeof fetch, supabaseUrl: string, serviceRoleKey: string): Promise<void> {
  const resp = await fetchFn(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/ai-image-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
  });
  await resp.body?.cancel();
  if (!resp.ok) console.warn(`[generate-image] ai-image-worker kick answered ${resp.status}; cron will pick the job up`);
}
