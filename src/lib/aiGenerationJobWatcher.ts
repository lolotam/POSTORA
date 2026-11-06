/**
 * Follows one ai_generation_jobs row to its end: Realtime for speed, polling ai-generation-status
 * for the result and as the fallback. At most one read is in flight; each read times out; the whole
 * watch has its own deadline. Only 401/403/404 or the deadline end it; any other failed read backs off.
 */
import { supabase } from "@/integrations/supabase/client";

export type AiJobStatus = "idle" | "running" | "succeeded" | "failed" | "timeout";
export interface AiJobSnapshot {
  status: AiJobStatus; videoUrl: string | null; imageUrl: string | null;
  error: string | null; errorCode: string | null; elapsedSeconds: number;
}

export const DEFAULT_POLL_SECONDS = 5;
export const MAX_POLL_MS = 10 * 60_000;
export const READ_TIMEOUT_MS = 20_000;
const BACKOFF_SECONDS = [5, 10, 20, 30];
const TERMINAL = new Set(["succeeded", "failed", "timeout", "canceled"]);
const FATAL_HTTP = new Set([401, 403, 404]);

function httpStatusOf(error: unknown): number | null {
  const status = (error as { context?: { status?: unknown } } | null)?.context?.status;
  return typeof status === "number" ? status : null;
}

export function watchAiGenerationJob(jobId: string, onChange: (s: AiJobSnapshot) => void): () => void {
  const startedAt = Date.now();
  let active = true;
  let inFlight = false;
  let pollAgain = false;
  let failures = 0;
  let readController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPollTimer = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; };
  const snapshot = (patch: Partial<AiJobSnapshot>): AiJobSnapshot => ({
    status: "running", videoUrl: null, imageUrl: null, error: null, errorCode: null,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), ...patch,
  });

  const channel = supabase.channel(`ai-generation-job-${jobId}`);
  const stop = () => {
    if (!active) return;
    active = false;
    clearPollTimer();
    clearTimeout(deadlineTimer);
    readController?.abort();
    void supabase.removeChannel(channel);
  };
  const finish = (patch: Partial<AiJobSnapshot>) => {
    if (!active) return;
    const last = snapshot(patch);
    stop();
    onChange(last);
  };
  const deadlineTimer = setTimeout(() => finish({ status: "timeout",
    error: "The generation is taking longer than expected. Check back shortly." }), MAX_POLL_MS);

  const schedule = (seconds: number) => {
    if (!active) return;
    clearPollTimer();
    pollTimer = setTimeout(() => void poll(), seconds * 1000);
  };

  const readStatus = () => {
    const controller = new AbortController();
    readController = controller;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      readTimer = setTimeout(() => {
        controller.abort();
        reject(new Error("status read timed out"));
      }, READ_TIMEOUT_MS);
    });
    return Promise.race([supabase.functions.invoke("ai-generation-status", { body: { jobId }, signal: controller.signal }), timeout])
      .finally(() => { clearTimeout(readTimer); readController = null; });
  };

  const poll = async (): Promise<void> => {
    if (!active || inFlight) return;
    clearPollTimer();
    inFlight = true;
    try {
      const { data, error } = await readStatus();
      if (!active) return;
      if (error) throw error;
      const status = String(data?.status ?? "");
      if (status === "succeeded") {
        finish({ status: "succeeded", videoUrl: data.videoUrl ?? data.imageUrl ?? data.url ?? null,
          imageUrl: data.imageUrl ?? data.videoUrl ?? data.url ?? null });
        return;
      }
      if (TERMINAL.has(status)) {
        finish({ status: status === "failed" ? "failed" : "timeout", error: data.error || "The generation did not complete.",
          errorCode: data.errorCode ?? null });
        return;
      }
      if (!status) throw new Error("Unexpected status response");
      failures = 0;
      onChange(snapshot({ status: "running" }));
      const next = Number(data?.pollAfterSeconds);
      schedule(Number.isFinite(next) && next > 0 ? Math.min(next, 30) : DEFAULT_POLL_SECONDS);
    } catch (err) {
      if (!active) return;
      const http = httpStatusOf(err);
      if (http !== null && FATAL_HTTP.has(http)) {
        finish(http === 404
          ? { status: "failed", error: "This generation could not be found.", errorCode: "job_not_found" }
          : { status: "failed", error: "Your session has expired. Refresh and try again.", errorCode: "unauthorized" });
        return;
      }
      failures += 1;
      schedule(BACKOFF_SECONDS[Math.min(failures - 1, BACKOFF_SECONDS.length - 1)]);
    } finally {
      inFlight = false;
      if (pollAgain && active) {
        pollAgain = false;
        clearPollTimer();
        void poll();
      }
    }
  };

  const pollNow = () => {
    if (!active) return;
    if (inFlight) { pollAgain = true; return; }
    void poll();
  };

  channel
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "ai_generation_jobs", filter: `id=eq.${jobId}` },
      (payload: { new?: { status?: string } }) => { if (TERMINAL.has(String(payload.new?.status))) pollNow(); })
    .subscribe();

  onChange(snapshot({ status: "running" }));
  schedule(DEFAULT_POLL_SECONDS);
  return stop;
}

export function awaitAiGenerationJob(jobId: string): Promise<AiJobSnapshot> {
  return new Promise((resolve) => {
    watchAiGenerationJob(jobId, (s) => { if (s.status !== "running" && s.status !== "idle") resolve(s); });
  });
}

/** Turns generate-image's answer into the synchronous shape every caller handles. A sync answer passes through. */
export async function resolveAiImageResponse(data: unknown): Promise<Record<string, unknown> | null> {
  const body = (data ?? null) as Record<string, unknown> | null;
  if (!body || typeof body.jobId !== "string") return body;
  const end = await awaitAiGenerationJob(body.jobId);
  if (end.status === "succeeded" && end.imageUrl) return { imageUrl: end.imageUrl, description: "" };
  return { success: false, error_code: end.errorCode ?? (end.status === "timeout" ? "ai_timeout" : "ai_error"),
    message: end.error ?? "Image generation failed" };
}
