import { useCallback, useEffect, useRef, useState } from "react";
import type { PublishState, PublishStatus } from "../domain/types";
import { ReviewGatewayError, useTikTokReviewGateway } from "./ports";

const BACKOFF_MS = [3_000, 5_000, 10_000, 20_000, 30_000];
const MAX_POLL_MS = 10 * 60 * 1000;

const RESTING: ReadonlySet<PublishState> = new Set(["scheduled", "published", "failed", "needs_attention"]);

function asGatewayError(caught: unknown): ReviewGatewayError {
  if (caught instanceof ReviewGatewayError) return caught;
  const message = caught instanceof Error && caught.message
    ? caught.message
    : "Status could not be loaded.";
  return new ReviewGatewayError("INTERNAL", message, 500);
}

export function usePublishStatus(submissionId: string | null): {
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
    const started = Date.now();
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
      try {
        const next = await gateway.status(submissionId);
        if (cancelled) return;
        setStatus(next);
        setError(null);
        stop = RESTING.has(next.state);
      } catch (caught) {
        if (cancelled) return;
        setError(asGatewayError(caught));
      } finally {
        inFlight.current = false;
      }
      if (cancelled || stop) return;
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
  }, [submissionId, cycle, gateway]);

  const refresh = useCallback(() => {
    setTimedOut(false);
    setCycle((value) => value + 1);
  }, []);

  return { status, error, timedOut, refresh };
}
