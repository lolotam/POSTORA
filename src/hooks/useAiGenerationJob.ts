/**
 * useAiGenerationJob Hook
 *
 * Uses Realtime + polling to follow a submitted generation job.
 * Video jobs run for minutes, so the submit call returns a job id immediately
 * and the result is collected here.
 *
 * @module hooks/useAiGenerationJob
 *
 * @example
 * const { status, videoUrl, error } = useAiGenerationJob(jobId);
 */

import { useEffect, useState } from "react";
import { watchAiGenerationJob, type AiJobSnapshot } from "@/lib/aiGenerationJobWatcher";
export type { AiJobStatus } from "@/lib/aiGenerationJobWatcher";

export interface AiGenerationJobState extends AiJobSnapshot { isPolling: boolean }
const INITIAL: AiGenerationJobState = { status: "idle", videoUrl: null, imageUrl: null, error: null, errorCode: null, isPolling: false, elapsedSeconds: 0 };

export function useAiGenerationJob(jobId: string | null): AiGenerationJobState {
  const [state, setState] = useState<AiGenerationJobState>(INITIAL);
  useEffect(() => {
    if (!jobId) { setState(INITIAL); return; }
    return watchAiGenerationJob(jobId, (s) => setState({ ...s, isPolling: s.status === "running" }));
  }, [jobId]);
  return state;
}
