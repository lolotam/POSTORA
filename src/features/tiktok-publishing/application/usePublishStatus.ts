import { useCallback, useEffect, useRef, useState } from "react";
import type { PublishState, PublishStatus } from "../domain/types";
import { ReviewGatewayError, useTikTokReviewGateway } from "./ports";

const BACKOFF_MS = [3_000, 5_000, 10_000, 20_000, 30_000];
const MAX_POLL_MS = 10 * 60 * 1000;

const RESTING: ReadonlySet<PublishState> = new Set(["published", "failed", "needs_attention"]);
// Signed out, not allowed, or the submission is gone: polling again cannot
// succeed, so it stops and the manual refresh stays available.
const UNRECOVERABLE_STATUS: ReadonlySet<number> = new Set([401, 403, 404]);

function asGatewayError(caught: unknown): ReviewGatewayError {
  if (caught instanceof ReviewGatewayError) return caught;
  const message = caught instanceof Error && caught.message
    ? caught.message
    : "Status could not be loaded.";
  return new ReviewGatewayError("INTERNAL", message, 500);
}

export function usePublishStatus(submissionId: string | null, scheduledAt?: string | null): {
  status: PublishStatus | null;
  error: ReviewGatewayError | null;
  timedOut: boolean;
  refresh: () => void;
} {
  const gateway = useTikTokReviewGateway();
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [error, setError] = useState<ReviewGatewayError | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [cycle, setCycle] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    setStatus(null);
    setError(null);
    setTimedOut(false);
  }, [submissionId]);

  useEffect(() => {
    if (!submissionId) return undefined;
    let cancelled = false;
    const scheduledMs = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
    let started = Date.now();
    let attempt = 0;
    let timer = 0;

    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        void poll();
      }, delay);
    };

    async function poll() {
      if (cancelled) return;
      if (Date.now() - started >= MAX_POLL_MS) {
        setTimedOut(true);
        return;
      }
      if (inFlight.current) {
        schedule(250);
        return;
      }
      inFlight.current = true;
      let stop = false;
      let wakeIn: number | null = null;
      try {
        const next = await gateway.status(submissionId);
        if (cancelled) return;
        setStatus(next);
        setError(null);
        stop = RESTING.has(next.state);
        if (next.state === "scheduled") {
          stop = !Number.isFinite(scheduledMs);
          if (scheduledMs > Date.now()) wakeIn = scheduledMs - Date.now();
        }
      } catch (caught) {
        if (cancelled) return;
        const failure = asGatewayError(caught);
        setError(failure);
        stop = UNRECOVERABLE_STATUS.has(failure.status);
      } finally {
        inFlight.current = false;
      }
      if (cancelled || stop) return;
      if (wakeIn !== null) {
        // Waiting for a future schedule does not consume the active polling budget.
        // Cap the wait at the browser's signed 32-bit timeout limit.
        timer = window.setTimeout(() => {
          started = Date.now();
          void poll();
        }, Math.min(wakeIn, 2_147_483_647));
        return;
      }
      if (Date.now() - started >= MAX_POLL_MS) {
        setTimedOut(true);
        return;
      }
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
      attempt += 1;
      schedule(delay);
    }

    void poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [submissionId, scheduledAt, cycle, gateway]);

  const refresh = useCallback(() => {
    setTimedOut(false);
    setCycle((value) => value + 1);
  }, []);

  return { status, error, timedOut, refresh };
}
