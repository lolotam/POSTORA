/**
 * useAiGenerationJob Hook
 *
 * Polls the ai-generation-status edge function for a submitted generation job.
 * Video jobs run for minutes, so the submit call returns a job id immediately
 * and the result is collected here.
 *
 * @module hooks/useAiGenerationJob
 *
 * @example
 * const { status, videoUrl, error } = useAiGenerationJob(jobId);
 */

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AiJobStatus = "idle" | "running" | "succeeded" | "failed" | "timeout";

export interface AiGenerationJobState {
  status: AiJobStatus;
  videoUrl: string | null;
  imageUrl: string | null;
  error: string | null;
  isPolling: boolean;
  /** Seconds elapsed since polling began; useful for progress copy. */
  elapsedSeconds: number;
}

const DEFAULT_POLL_SECONDS = 5;

/** Stop polling well before a job could plausibly still be alive. */
const MAX_POLL_MS = 10 * 60_000;

/** Consecutive status-check failures tolerated before reporting failure. */
const MAX_CONSECUTIVE_ERRORS = 3;

const INITIAL: AiGenerationJobState = {
  status: "idle",
  videoUrl: null,
  imageUrl: null,
  error: null,
  isPolling: false,
  elapsedSeconds: 0,
};

export function useAiGenerationJob(jobId: string | null): AiGenerationJobState {
  const [state, setState] = useState<AiGenerationJobState>(INITIAL);

  // Held in a ref so the polling loop can bail out immediately on unmount or
  // when the caller switches to a different job.
  const activeRef = useRef(true);

  useEffect(() => {
    if (!jobId) {
      setState(INITIAL);
      return;
    }

    activeRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A cold start or a network blip must not be reported as a failed
    // generation: the job keeps running upstream and its result would never be
    // collected. Only give up after several consecutive failures.
    let consecutiveErrors = 0;
    const startedAt = Date.now();

    setState({ ...INITIAL, status: "running", isPolling: true });

    const finish = (patch: Partial<AiGenerationJobState>) => {
      if (!activeRef.current) return;
      setState((prev) => ({ ...prev, ...patch, isPolling: false }));
    };

    const poll = async () => {
      if (!activeRef.current) return;

      const elapsed = Date.now() - startedAt;
      if (elapsed > MAX_POLL_MS) {
        finish({
          status: "timeout",
          error: "The generation is taking longer than expected. Check back shortly.",
        });
        return;
      }

      try {
        const { data, error } = await supabase.functions.invoke("ai-generation-status", {
          body: { jobId },
        });
        if (!activeRef.current) return;
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        consecutiveErrors = 0;

        if (data?.status === "succeeded") {
          finish({
            status: "succeeded",
            videoUrl: data.videoUrl ?? null,
            imageUrl: data.imageUrl ?? null,
          });
          return;
        }

        if (
          data?.status === "failed" ||
          data?.status === "timeout" ||
          data?.status === "canceled"
        ) {
          finish({
            status: data.status === "failed" ? "failed" : "timeout",
            error: data.error || "The generation did not complete.",
          });
          return;
        }

        setState((prev) => ({
          ...prev,
          status: "running",
          isPolling: true,
          elapsedSeconds: Math.round(elapsed / 1000),
        }));

        const nextDelay = Number(data?.pollAfterSeconds);
        const delaySeconds =
          Number.isFinite(nextDelay) && nextDelay > 0
            ? Math.min(nextDelay, 30)
            : DEFAULT_POLL_SECONDS;
        timer = setTimeout(poll, delaySeconds * 1000);
      } catch (err) {
        if (!activeRef.current) return;

        consecutiveErrors += 1;
        if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
          timer = setTimeout(poll, DEFAULT_POLL_SECONDS * 1000);
          return;
        }

        finish({
          status: "failed",
          error: err instanceof Error ? err.message : "Could not check the generation status.",
        });
      }
    };

    // Give the provider a moment before the first check.
    timer = setTimeout(poll, DEFAULT_POLL_SECONDS * 1000);

    return () => {
      activeRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  return state;
}
